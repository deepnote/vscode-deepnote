import { inject, injectable } from 'inversify';

import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../types';
import {
    DetectedIntegration,
    isConfigurableDatabaseIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationDetector, IIntegrationStorage, IntegrationDetectionInput } from './types';

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
     * Detect all integrations for the notebook's project. Two inputs, two roles:
     * - `project.integrations` is the roster (ids, names and types only — never credentials), so it decides
     *   which integrations the panel lists at all.
     * - SecretStorage supplies the editable config for each one; integrations configured only in
     *   `.deepnote.env.yaml` stay `null` here, since those configs are never persisted through it.
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

        const declarations = project.project.integrations ?? [];

        logger.debug(`IntegrationDetector: Project ${projectId} declares ${declarations.length} integrations`);

        const integrations = new Map<string, DetectedIntegration>();

        for (const declaration of declarations) {
            const integrationType = declaration.type;
            if (!isConfigurableDatabaseIntegrationType(integrationType)) {
                logger.debug(`IntegrationDetector: Skipping unsupported integration type: ${integrationType}`);
                continue;
            }

            const storedConfig = await this.integrationStorage.getIntegrationConfig(declaration.id);

            integrations.set(declaration.id, {
                config: storedConfig ?? null,
                integrationName: declaration.name,
                integrationType
            });
        }

        logger.debug(`IntegrationDetector: Found ${integrations.size} integrations`);

        return integrations;
    }
}
