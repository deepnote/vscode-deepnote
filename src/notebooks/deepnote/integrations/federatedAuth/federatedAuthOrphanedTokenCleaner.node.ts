import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { IDisposableRegistry } from '../../../../platform/common/types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IFederatedAuthTokenStorage } from '../types';
import { logger } from '../../../../platform/logging';

/**
 * Prunes federated-auth tokens only when this host witnesses an integration leave SecretStorage
 * (`onDidChangeIntegrations`); file-backed integrations are never treated as orphans.
 * Removals in other windows/sessions are not witnessed — the panel's `tokenStorage.delete` covers those,
 * preferring over-retention over a wrongly deleted token.
 */
@injectable()
export class FederatedAuthOrphanedTokenCleaner implements IExtensionSyncActivationService {
    /**
     * Serializes runs. Both the snapshot read and its replacement straddle an `await`, so two overlapping
     * observations would pair one run's `getAll()` result against the other's snapshot and "witness" a removal
     * that never happened.
     */
    private cleanupQueue: Promise<void> = Promise.resolve();

    /** Ids observed in {@link IIntegrationStorage} on the previous run; `undefined` until the first observation. */
    private knownIntegrationIds: Set<string> | undefined;

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

    /** Queues an observation behind any run already in flight; see {@link cleanupQueue}. */
    private cleanupOrphanedTokens(): Promise<void> {
        const run = this.cleanupQueue.then(() => this.observeAndCleanup());
        // The queue has to survive a failed run, so swallow the rejection here only — `run` still carries it to
        // the caller, which logs it.
        this.cleanupQueue = run.then(undefined, () => undefined);

        return run;
    }

    private async observeAndCleanup(): Promise<void> {
        const [tokenIds, integrations] = await Promise.all([
            this.tokenStorage.listIntegrationIds(),
            this.integrationStorage.getAll()
        ]);

        // Record the snapshot before any early return, so a removal that happens while nothing is stored is still
        // witnessed instead of being compared against a stale set on the next run.
        const currentIntegrationIds = new Set(integrations.map((integration) => integration.id));
        const previousIntegrationIds = this.knownIntegrationIds;

        this.knownIntegrationIds = currentIntegrationIds;

        // The first observation of this session witnessed no removal, so nothing is provably orphaned. Absence
        // alone is not evidence: a token can legitimately belong to a `.deepnote.env.yaml` integration that
        // SecretStorage never holds.
        if (!previousIntegrationIds) {
            logger.debug(
                'FederatedAuthOrphanedTokenCleaner: Recorded the first integration snapshot, nothing witnessed yet.'
            );
            return;
        }

        if (tokenIds.length === 0) {
            logger.debug('FederatedAuthOrphanedTokenCleaner: No federated tokens stored, nothing to clean up.');
            return;
        }

        const removedIntegrationIds = new Set(
            [...previousIntegrationIds].filter((id) => !currentIntegrationIds.has(id))
        );
        const orphanedIds = tokenIds.filter((id) => removedIntegrationIds.has(id));

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
