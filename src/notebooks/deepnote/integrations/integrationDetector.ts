import { inject, injectable, optional } from 'inversify';
import { workspace } from 'vscode';

import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../types';
import {
    ConfigurableDatabaseIntegrationType,
    IntegrationStatus,
    IntegrationWithStatus
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationDetector, IIntegrationStorage } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { DatabaseIntegrationConfig, databaseIntegrationTypes } from '@deepnote/database-integrations';

/**
 * Service for detecting integrations used in Deepnote notebooks
 */
@injectable()
export class IntegrationDetector implements IIntegrationDetector {
    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(ISqlIntegrationEnvVarsProvider)
        @optional()
        private readonly sqlIntegrationEnvVars?: ISqlIntegrationEnvVarsProvider
    ) {}

    /**
     * Detect all integrations used in the given project.
     * Uses the project's integrations field as the source of truth.
     */
    async detectIntegrations(projectId: string, notebookId: string): Promise<Map<string, IntegrationWithStatus>> {
        // Get the project
        const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);
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

        // Merged (SecretStorage + `.deepnote.env.yaml`) configs, so file-configured integrations are not shown as
        // unconfigured (F13). Resolved from the open notebook document; when the merged provider is unavailable
        // (e.g. web) this stays empty and detection falls back to SecretStorage only.
        const mergedConfigsById = new Map<string, DatabaseIntegrationConfig>();
        const notebookUri = workspace.notebookDocuments.find(
            (nb) => nb.metadata?.deepnoteProjectId === projectId && nb.metadata?.deepnoteNotebookId === notebookId
        )?.uri;
        if (this.sqlIntegrationEnvVars && notebookUri) {
            for (const config of await this.sqlIntegrationEnvVars.getMergedConfigs(notebookUri)) {
                mergedConfigsById.set(config.id, config);
            }
        }

        for (const projectIntegration of projectIntegrations) {
            const integrationId = projectIntegration.id;
            const integrationType = projectIntegration.type;
            if (
                !(databaseIntegrationTypes as readonly string[]).includes(integrationType) ||
                integrationType === 'pandas-dataframe'
            ) {
                logger.debug(`IntegrationDetector: Skipping unsupported integration type: ${integrationType}`);
                continue;
            }

            // Configured if SecretStorage has it OR a `.deepnote.env.yaml` file config provides it.
            const config = await this.integrationStorage.getIntegrationConfig(integrationId);
            const isConfigured = config != null || mergedConfigsById.has(integrationId);
            const status: IntegrationWithStatus = {
                config: config ?? null,
                status: isConfigured ? IntegrationStatus.Connected : IntegrationStatus.Disconnected,
                // Include integration metadata from project for prefilling when config is null
                integrationName: projectIntegration.name,
                integrationType: integrationType as ConfigurableDatabaseIntegrationType
            };

            integrations.set(integrationId, status);
        }

        // Append file-only integrations (present in `.deepnote.env.yaml` but not declared in project.integrations).
        for (const [integrationId, fileConfig] of mergedConfigsById) {
            if (
                integrations.has(integrationId) ||
                !(databaseIntegrationTypes as readonly string[]).includes(fileConfig.type) ||
                fileConfig.type === 'pandas-dataframe'
            ) {
                continue;
            }
            integrations.set(integrationId, {
                config: null,
                status: IntegrationStatus.Connected,
                integrationName: fileConfig.name,
                integrationType: fileConfig.type as ConfigurableDatabaseIntegrationType
            });
        }

        logger.debug(`IntegrationDetector: Found ${integrations.size} integrations`);

        return integrations;
    }

    /**
     * Check if a project has any unconfigured integrations
     */
    async hasUnconfiguredIntegrations(projectId: string, notebookId: string): Promise<boolean> {
        const integrations = await this.detectIntegrations(projectId, notebookId);

        for (const integration of integrations.values()) {
            if (integration.status === IntegrationStatus.Disconnected) {
                return true;
            }
        }

        return false;
    }
}
