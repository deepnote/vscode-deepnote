import { inject, injectable } from 'inversify';

import { IDeepnoteNotebookManager } from '../../types';
import { IntegrationStatus, IntegrationWithStatus } from './integrationTypes';
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
            console.log(`[IntegrationDetector] No project found for ID: ${projectId}`);
            return integrations;
        }

        console.log(
            `[IntegrationDetector] Scanning project ${projectId} with ${project.project.notebooks.length} notebooks`
        );

        // Scan all notebooks in the project
        for (const notebook of project.project.notebooks) {
            console.log(`[IntegrationDetector] Scanning notebook ${notebook.id} with ${notebook.blocks.length} blocks`);

            // Scan all blocks in the notebook
            for (const block of notebook.blocks) {
                // Check if this is a code block with SQL integration metadata
                if (block.type === 'code' && block.metadata?.sql_integration_id) {
                    const integrationId = block.metadata.sql_integration_id;

                    console.log(`[IntegrationDetector] Found integration: ${integrationId} in block ${block.id}`);

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
                } else if (block.type === 'code') {
                    console.log(
                        `[IntegrationDetector] Block ${block.id} has no sql_integration_id. Metadata:`,
                        block.metadata
                    );
                }
            }
        }

        console.log(`[IntegrationDetector] Found ${integrations.size} integrations`);
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
