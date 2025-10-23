import { inject, injectable } from 'inversify';

import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../types';
import {
    DATAFRAME_SQL_INTEGRATION_ID,
    IntegrationStatus,
    IntegrationWithStatus,
    mapDeepnoteIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationDetector, IIntegrationStorage } from './types';

/**
 * Service for detecting integrations used in Deepnote notebooks
 */
@injectable()
export class IntegrationDetector implements IIntegrationDetector {
    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager
    ) {}

    /**
     * Detect all integrations used in the given project.
     * Uses the project's integrations field as the source of truth.
     */
    async detectIntegrations(projectId: string): Promise<Map<string, IntegrationWithStatus>> {
        // Get the project
        const project = this.notebookManager.getOriginalProject(projectId);
        if (!project) {
            logger.warn(
                `IntegrationDetector: No project found for ID: ${projectId}. The project may not have been loaded yet.`
            );
            return new Map();
        }

        logger.debug(`IntegrationDetector: Scanning project ${projectId} for integrations`);

        const integrations = new Map<string, IntegrationWithStatus>();

        // Use the project's integrations field as the source of truth
        const projectIntegrations = project.project.integrations || [];
        logger.debug(`IntegrationDetector: Found ${projectIntegrations.length} integrations in project.integrations`);

        for (const projectIntegration of projectIntegrations) {
            const integrationId = projectIntegration.id;

            // Skip the internal DuckDB integration
            if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
                continue;
            }

            logger.debug(`IntegrationDetector: Found integration: ${integrationId} (${projectIntegration.type})`);

            // Check if the integration is configured
            const config = await this.integrationStorage.getIntegrationConfig(integrationId);

            // Map the Deepnote integration type to our IntegrationType
            const integrationType = mapDeepnoteIntegrationType(projectIntegration.type);

            const status: IntegrationWithStatus = {
                config: config || null,
                status: config ? IntegrationStatus.Connected : IntegrationStatus.Disconnected,
                // Include integration metadata from project for prefilling when config is null
                integrationName: projectIntegration.name,
                integrationType: integrationType
            };

            integrations.set(integrationId, status);
        }

        logger.debug(`IntegrationDetector: Found ${integrations.size} integrations`);

        return integrations;
    }

    /**
     * Check if a project has any unconfigured integrations
     */
    async hasUnconfiguredIntegrations(projectId: string): Promise<boolean> {
        const integrations = await this.detectIntegrations(projectId);

        for (const integration of integrations.values()) {
            if (integration.status === IntegrationStatus.Disconnected) {
                return true;
            }
        }

        return false;
    }
}
