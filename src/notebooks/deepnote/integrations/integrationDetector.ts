import { inject, injectable } from 'inversify';

import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager } from '../../types';
import { IntegrationStatus, IntegrationWithStatus } from '../../../platform/notebooks/deepnote/integrationTypes';
import { IIntegrationDetector, IIntegrationStorage } from './types';
import { BlockWithIntegration, scanBlocksForIntegrations } from './integrationUtils';

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
        // Get the project
        const project = this.notebookManager.getOriginalProject(projectId);
        if (!project) {
            logger.warn(
                `IntegrationDetector: No project found for ID: ${projectId}. The project may not have been loaded yet.`
            );
            return new Map();
        }

        logger.debug(
            `IntegrationDetector: Scanning project ${projectId} with ${project.project.notebooks.length} notebooks`
        );

        // Collect all blocks with SQL integration metadata from all notebooks
        const blocksWithIntegrations: BlockWithIntegration[] = [];
        for (const notebook of project.project.notebooks) {
            logger.trace(`IntegrationDetector: Scanning notebook ${notebook.id} with ${notebook.blocks.length} blocks`);

            for (const block of notebook.blocks) {
                // Check if this is a code block with SQL integration metadata
                if (block.type === 'code' && block.metadata?.sql_integration_id) {
                    blocksWithIntegrations.push({
                        id: block.id,
                        sql_integration_id: block.metadata.sql_integration_id
                    });
                } else if (block.type === 'code') {
                    logger.trace(
                        `IntegrationDetector: Block ${block.id} has no sql_integration_id. Metadata:`,
                        block.metadata
                    );
                }
            }
        }

        // Use the shared utility to scan blocks and build the status map
        return scanBlocksForIntegrations(blocksWithIntegrations, this.integrationStorage, 'IntegrationDetector');
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
