import { inject, injectable } from 'inversify';

import { IDeepnoteNotebookManager } from '../../types';
import { IntegrationStatus, IntegrationType, IntegrationWithStatus } from './integrationTypes';
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
     * Detect all integrations used in the given project
     */
    async detectIntegrations(projectId: string): Promise<Map<string, IntegrationWithStatus>> {
        const integrations = new Map<string, IntegrationWithStatus>();

        // Get the project
        const project = this.notebookManager.getOriginalProject(projectId);
        if (!project) {
            return integrations;
        }

        // Scan all notebooks in the project
        for (const notebook of project.project.notebooks) {
            // Scan all blocks in the notebook
            for (const block of notebook.blocks) {
                // Check if this is a code block with integration metadata
                if (block.type === 'code' && block.metadata?.integration) {
                    const integrationRef = block.metadata.integration;
                    const integrationId = integrationRef.id;

                    // Skip if we've already detected this integration
                    if (integrations.has(integrationId)) {
                        continue;
                    }

                    // Check if the integration is configured
                    const config = await this.integrationStorage.get(integrationId);

                    const status: IntegrationWithStatus = {
                        config: config || null,
                        status: config ? IntegrationStatus.Connected : IntegrationStatus.Disconnected
                    };

                    integrations.set(integrationId, status);
                }
            }
        }

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

