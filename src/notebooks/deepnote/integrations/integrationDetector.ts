import { inject, injectable } from 'inversify';

import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../types';
import { IntegrationStatus, IntegrationWithStatus } from '../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationDetector, IIntegrationStorage } from './types';
import { DatabaseIntegrationType, databaseIntegrationTypes } from '@deepnote/database-integrations';

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
        const projectIntegrations = project.project.integrations?.slice() ?? [];
        logger.debug(`IntegrationDetector: Found ${projectIntegrations.length} integrations in project.integrations`);

        for (const projectIntegration of projectIntegrations) {
            const integrationId = projectIntegration.id;
            const integrationType = projectIntegration.type;
            if (!(databaseIntegrationTypes as readonly string[]).includes(integrationType)) {
                logger.debug(`IntegrationDetector: Skipping unsupported integration type: ${integrationType}`);
                continue;
            }

            // Check if the integration is configured
            const config = await this.integrationStorage.getIntegrationConfig(integrationId);
            const status: IntegrationWithStatus = {
                config: config ?? null,
                status: config ? IntegrationStatus.Connected : IntegrationStatus.Disconnected,
                // Include integration metadata from project for prefilling when config is null
                integrationName: projectIntegration.name,
                integrationType: integrationType as DatabaseIntegrationType
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
