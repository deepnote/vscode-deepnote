import { logger } from '../../../platform/logging';
import { IIntegrationStorage } from './types';
import {
    DATAFRAME_SQL_INTEGRATION_ID,
    IntegrationStatus,
    IntegrationWithStatus
} from '../../../platform/notebooks/deepnote/integrationTypes';

/**
 * Represents a block with SQL integration metadata
 */
export interface BlockWithIntegration {
    id: string;
    sql_integration_id: string;
}

/**
 * Scans blocks for SQL integrations and builds a status map.
 * This is the core logic shared between IntegrationDetector and IntegrationManager.
 *
 * @param blocks - Iterator of blocks to scan (can be from Deepnote project or VSCode notebook cells)
 * @param integrationStorage - Storage service to check configuration status
 * @param logContext - Context string for logging (e.g., "IntegrationDetector", "IntegrationManager")
 * @returns Map of integration IDs to their status
 */
export async function scanBlocksForIntegrations(
    blocks: Iterable<BlockWithIntegration>,
    integrationStorage: IIntegrationStorage,
    logContext: string
): Promise<Map<string, IntegrationWithStatus>> {
    const integrations = new Map<string, IntegrationWithStatus>();

    for (const block of blocks) {
        const integrationId = block.sql_integration_id;

        // Skip blocks without integration IDs
        if (!integrationId) {
            continue;
        }

        // Skip excluded integrations (e.g., internal DuckDB integration)
        if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
            logger.trace(`${logContext}: Skipping excluded integration: ${integrationId} in block ${block.id}`);
            continue;
        }

        // Skip if we've already detected this integration
        if (integrations.has(integrationId)) {
            continue;
        }

        logger.debug(`${logContext}: Found integration: ${integrationId} in block ${block.id}`);

        // Check if the integration is configured
        const config = await integrationStorage.get(integrationId);

        const status: IntegrationWithStatus = {
            config: config || null,
            status: config ? IntegrationStatus.Connected : IntegrationStatus.Disconnected
        };

        integrations.set(integrationId, status);
    }

    logger.debug(`${logContext}: Found ${integrations.size} integrations`);

    return integrations;
}
