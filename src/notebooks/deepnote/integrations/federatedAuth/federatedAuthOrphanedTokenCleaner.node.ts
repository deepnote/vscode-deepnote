import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { IDisposableRegistry } from '../../../../platform/common/types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IFederatedAuthTokenStorage } from '../types';
import { logger } from '../../../../platform/logging';

/**
 * Node-only listener that prunes federated-auth tokens whose integration
 * has been deleted (or whose integration list was cleared entirely).
 *
 * Bound only on node because {@link IFederatedAuthTokenStorage} is
 * node-only. We deliberately do **not** modify
 * `IntegrationStorage.clear()` / `IntegrationStorage.delete()` to call
 * the token storage directly — that would force the platform-layer
 * service to import a node-only dependency, breaking the web build.
 *
 * Strategy: subscribe to {@link IIntegrationStorage.onDidChangeIntegrations}.
 * On every fire, diff the current integration IDs against the set of IDs
 * known to {@link IFederatedAuthTokenStorage} and delete the orphans.
 * This covers both the "single delete" and "clear all" paths.
 */
@injectable()
export class FederatedAuthOrphanedTokenCleaner implements IExtensionSyncActivationService {
    constructor(
        @inject(IFederatedAuthTokenStorage) private readonly tokenStorage: IFederatedAuthTokenStorage,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        logger.info('FederatedAuthOrphanedTokenCleaner: Initialized');

        disposables.push(
            this.integrationStorage.onDidChangeIntegrations(() => {
                this.cleanupOrphanedTokens().catch((err) =>
                    logger.error('FederatedAuthOrphanedTokenCleaner: Failed to clean up orphaned tokens', err)
                );
            })
        );
    }

    public activate(): void {
        // Service is activated via constructor.
    }

    private async cleanupOrphanedTokens(): Promise<void> {
        const [tokenIds, integrations] = await Promise.all([
            this.tokenStorage.listIntegrationIds(),
            this.integrationStorage.getAll()
        ]);

        if (tokenIds.length === 0) {
            logger.debug('FederatedAuthOrphanedTokenCleaner: No federated tokens stored, nothing to clean up.');
            return;
        }

        const currentIntegrationIds = new Set(integrations.map((integration) => integration.id));
        const orphanedIds = tokenIds.filter((id) => !currentIntegrationIds.has(id));

        if (orphanedIds.length === 0) {
            logger.debug('FederatedAuthOrphanedTokenCleaner: No orphaned tokens to clean up.');
            return;
        }

        logger.info(
            `FederatedAuthOrphanedTokenCleaner: Cleaning up ${orphanedIds.length} orphaned token(s): ${orphanedIds.join(
                ', '
            )}`
        );

        for (const id of orphanedIds) {
            try {
                await this.tokenStorage.delete(id);
                logger.debug(`FederatedAuthOrphanedTokenCleaner: Deleted orphaned token for integration ${id}`);
            } catch (error) {
                logger.error(
                    `FederatedAuthOrphanedTokenCleaner: Failed to delete orphaned token for integration ${id}`,
                    error
                );
            }
        }
    }
}
