import { inject, injectable } from 'inversify';
import { Uri } from 'vscode';

import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../types';
import {
    DetectedIntegration,
    isConfigurableDatabaseIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { IIntegrationDetector, IIntegrationStorage, IntegrationDetectionInput } from './types';

/**
 * Service for detecting integrations used in Deepnote notebooks
 */
@injectable()
export class IntegrationDetector implements IIntegrationDetector {
    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider
    ) {}

    /**
     * Detect all integrations for the notebook's project. Three inputs, three roles:
     * - `project.integrations` is the roster (ids, names and types only — never credentials), so it decides
     *   the order and the names the panel shows.
     * - SecretStorage supplies the editable config for each one; integrations configured only in
     *   `.deepnote.env.yaml` stay `null` here, since those configs are never persisted through it.
     * - `.deepnote.env.yaml` entries missing from the roster are appended, matching what actually applies at
     *   execution time. Without this a file-only integration works but is invisible, and a federated one is
     *   unusable outright — its Authenticate action exists only as a row in this panel.
     */
    async detectIntegrations(input: IntegrationDetectionInput): Promise<Map<string, DetectedIntegration>> {
        const { projectId, notebookId } = input;

        const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);
        if (!project) {
            logger.warn(
                `IntegrationDetector: No project found for ID: ${projectId}. The project may not have been loaded yet.`
            );

            return new Map();
        }

        const projectIntegrations = project.project.integrations ?? [];

        logger.debug(`IntegrationDetector: Project ${projectId} declares ${projectIntegrations.length} integrations`);

        const integrations = new Map<string, DetectedIntegration>();

        for (const projectIntegration of projectIntegrations) {
            const integrationType = projectIntegration.type;
            if (!isConfigurableDatabaseIntegrationType(integrationType)) {
                logger.debug(`IntegrationDetector: Skipping unsupported integration type: ${integrationType}`);
                continue;
            }

            const storedConfig = await this.integrationStorage.getIntegrationConfig(projectIntegration.id);

            integrations.set(projectIntegration.id, {
                config: storedConfig ?? null,
                integrationName: projectIntegration.name,
                integrationType
            });
        }

        await this.appendFileOnlyIntegrations(input.notebookUri, integrations);

        logger.debug(`IntegrationDetector: Found ${integrations.size} integrations`);

        return integrations;
    }

    /**
     * Adds `.deepnote.env.yaml` integrations the roster omits. `config` stays `null` because the panel edits
     * SecretStorage only and the file layer cannot be written back; the name and type are carried so the row
     * renders. A failed lookup leaves the roster-only result rather than blocking the panel.
     */
    private async appendFileOnlyIntegrations(
        notebookUri: Uri,
        integrations: Map<string, DetectedIntegration>
    ): Promise<void> {
        let mergedConfigs: DatabaseIntegrationConfig[];

        try {
            mergedConfigs = await this.sqlIntegrationEnvVars.getMergedIntegrationConfigs(notebookUri);
        } catch (error) {
            logger.error('IntegrationDetector: failed to read file integrations; listing the roster only', error);

            return;
        }

        for (const config of mergedConfigs) {
            // Anything merged but absent here came from the file alone — the merge resolves roster ids first.
            if (integrations.has(config.id) || !isConfigurableDatabaseIntegrationType(config.type)) {
                continue;
            }

            logger.debug(`IntegrationDetector: Adding file-only integration ${config.id}`);
            integrations.set(config.id, {
                config: null,
                integrationName: config.name,
                integrationType: config.type
            });
        }
    }
}
