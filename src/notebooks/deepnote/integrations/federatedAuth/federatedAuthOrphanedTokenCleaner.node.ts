import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { IDisposableRegistry } from '../../../../platform/common/types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IFederatedAuthTokenStorage } from '../types';
import { logger } from '../../../../platform/logging';

/**
 * Node-only listener that prunes federated-auth tokens when an integration is deleted: subscribes to
 * `onDidChangeIntegrations` and diffs current IDs against {@link IFederatedAuthTokenStorage.listIntegrationIds}.
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
        this.cleanupOrphanedTokens().catch((err) =>
            logger.error('FederatedAuthOrphanedTokenCleaner: Initial orphaned token cleanup failed', err)
        );
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
