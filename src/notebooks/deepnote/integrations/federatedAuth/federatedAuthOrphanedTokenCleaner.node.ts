import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../../../platform/activation/types';
import { IDisposableRegistry } from '../../../../platform/common/types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { IFederatedAuthTokenStorage } from '../types';
import { logger } from '../../../../platform/logging';

/**
 * Node-only listener that prunes federated-auth tokens when an integration is deleted: subscribes to
 * `onDidChangeIntegrations` and deletes a token only once it has **witnessed** the removal of its integration —
 * an id present in a previous observation of {@link IIntegrationStorage} and gone from the current one.
 *
 * Absence from SecretStorage alone is not evidence of orphaning: a token can legitimately belong to an
 * integration declared in `.deepnote.env.yaml`, which SecretStorage never holds.
 *
 * The cost of that rule: `onDidChangeIntegrations` is a per-extension-host emitter, so a removal performed in
 * another window — or in an earlier session — is never witnessed here at all. Every later session seeds its first
 * snapshot from a SecretStorage that already lacks the id, so it can never appear in a previous observation and
 * this cleaner will retain its token indefinitely, not merely until the next session. The panel's own
 * `tokenStorage.delete` remains the primary path for those. The asymmetry is deliberate: an over-retained token
 * is inert, whereas a wrongly deleted one costs a full re-authentication.
 */
@injectable()
export class FederatedAuthOrphanedTokenCleaner implements IExtensionSyncActivationService {
    /**
     * Serialises runs. Both the snapshot read and its replacement straddle an `await`, so two overlapping
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
