import sinon from 'sinon';
import { Disposable, EventEmitter } from 'vscode';

import { FederatedAuthOrphanedTokenCleaner } from './federatedAuthOrphanedTokenCleaner.node';
import { FederatedAuthTokenEntry, IFederatedAuthTokenStorage } from '../types';
import { IDisposable } from '../../../../platform/common/types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { dispose } from '../../../../platform/common/utils/lifecycle';
import { buildGoogleOauthIntegration, buildTokenEntry, settleAsyncHandlers } from './federatedAuthTestHelpers';
import type { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';

suite('FederatedAuthOrphanedTokenCleaner', () => {
    let disposables: IDisposable[];
    let integrations: Map<string, ConfigurableDatabaseIntegrationConfig>;
    let tokens: Map<string, FederatedAuthTokenEntry>;
    let onDidChangeIntegrations: EventEmitter<void>;
    let onDidChangeTokens: EventEmitter<string>;
    let deleteSpy: sinon.SinonSpy<[string], Promise<void>>;
    let integrationStorage: IIntegrationStorage;
    let tokenStorage: IFederatedAuthTokenStorage;

    function buildTokenStorage(throwOnDelete?: Set<string>): IFederatedAuthTokenStorage {
        deleteSpy = sinon.spy(async (id: string) => {
            if (throwOnDelete?.has(id)) {
                throw new Error(`forced throw on delete: ${id}`);
            }
            tokens.delete(id);
        });
        return {
            onDidChangeTokens: onDidChangeTokens.event,
            computeMetadataFingerprint: () => 'fp',
            delete: deleteSpy,
            get: async (id) => tokens.get(id),
            has: async (id) => tokens.has(id),
            listIntegrationIds: async () => Array.from(tokens.keys()),
            save: async (entry) => {
                tokens.set(entry.integrationId, entry);
            }
        };
    }

    function fireChangeAndWait(): Promise<void> {
        onDidChangeIntegrations.fire();
        return settleAsyncHandlers();
    }

    setup(() => {
        disposables = [];
        integrations = new Map();
        tokens = new Map();
        onDidChangeIntegrations = new EventEmitter<void>();
        onDidChangeTokens = new EventEmitter<string>();
        integrationStorage = {
            onDidChangeIntegrations: onDidChangeIntegrations.event,
            dispose: () => onDidChangeIntegrations.dispose(),
            async clear() {
                integrations.clear();
            },
            async delete(id) {
                integrations.delete(id);
            },
            async exists(id) {
                return integrations.has(id);
            },
            async getAll() {
                return Array.from(integrations.values());
            },
            async getIntegrationConfig(id) {
                return integrations.get(id);
            },
            async getProjectIntegrationConfig() {
                return undefined;
            },
            async save(config) {
                integrations.set(config.id, config);
            }
        };
        tokenStorage = buildTokenStorage();
        disposables.push(new Disposable(() => onDidChangeIntegrations.dispose()));
        disposables.push(new Disposable(() => onDidChangeTokens.dispose()));
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('never deletes a token SecretStorage has never held, on the first run or later', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        tokens.set('file-only', buildTokenEntry({ integrationId: 'file-only' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        await fireChangeAndWait();
        // An unrelated integration is saved, which is exactly the event that used to wipe the file-backed token.
        integrations.set('bq-2', buildGoogleOauthIntegration({ id: 'bq-2' }));
        await fireChangeAndWait();
        await fireChangeAndWait();

        sinon.assert.notCalled(deleteSpy);
    });

    test('serialises overlapping runs so a slow observation cannot witness a removal that never happened', async () => {
        // Declared only in `.deepnote.env.yaml`, so SecretStorage never holds it.
        tokens.set('file-only', buildTokenEntry({ integrationId: 'file-only' }));

        let releaseFirstRead: (() => void) | undefined;
        const firstReadBlocked = new Promise<void>((resolve) => {
            releaseFirstRead = resolve;
        });
        let reads = 0;
        integrationStorage.getAll = async () => {
            reads += 1;
            if (reads === 1) {
                // The activation read is still walking the keychain when the next event arrives.
                await firstReadBlocked;

                return [];
            }

            return [buildGoogleOauthIntegration({ id: 'file-only' })];
        };

        const cleaner = new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        cleaner.activate();
        // A save reusing the file-declared id lands while the activation read is still in flight. Unserialised,
        // this run finishes first, records its ids as the snapshot, and the stale run then reads that snapshot
        // and "witnesses" a removal against its own older, empty read.
        onDidChangeIntegrations.fire();
        await settleAsyncHandlers();

        releaseFirstRead?.();
        await settleAsyncHandlers();

        sinon.assert.notCalled(deleteSpy);
    });

    test('deletes a token only once it has witnessed its integration being removed', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        integrations.set('orphan-a', buildGoogleOauthIntegration({ id: 'orphan-a' }));
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        tokens.set('orphan-a', buildTokenEntry({ integrationId: 'orphan-a' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        // First run only records which ids SecretStorage holds; no removal has been witnessed yet.
        await fireChangeAndWait();

        sinon.assert.notCalled(deleteSpy);

        integrations.delete('orphan-a');

        await fireChangeAndWait();

        sinon.assert.calledWith(deleteSpy, 'orphan-a');
        sinon.assert.neverCalledWith(deleteSpy, 'bq-1');
    });

    test('witnesses a removal even when the previous run stored no tokens', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        // Nothing to clean up yet, but `bq-1` must still be recorded as observed.
        await fireChangeAndWait();

        // The user authenticates and then deletes the integration, both between the two runs.
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        integrations.delete('bq-1');

        await fireChangeAndWait();

        sinon.assert.calledWith(deleteSpy, 'bq-1');
    });

    test('seeds the snapshot from the activation run', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));

        const cleaner = new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        cleaner.activate();
        await settleAsyncHandlers();

        sinon.assert.notCalled(deleteSpy);

        integrations.delete('bq-1');

        await fireChangeAndWait();

        sinon.assert.calledWith(deleteSpy, 'bq-1');
    });

    test('continues deleting other orphans when one delete fails', async () => {
        tokenStorage = buildTokenStorage(new Set(['orphan-a']));
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        integrations.set('orphan-a', buildGoogleOauthIntegration({ id: 'orphan-a' }));
        integrations.set('orphan-b', buildGoogleOauthIntegration({ id: 'orphan-b' }));
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        tokens.set('orphan-a', buildTokenEntry({ integrationId: 'orphan-a' }));
        tokens.set('orphan-b', buildTokenEntry({ integrationId: 'orphan-b' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        await fireChangeAndWait();
        integrations.delete('orphan-a');
        integrations.delete('orphan-b');
        await fireChangeAndWait();

        // Both attempts must have happened, even after orphan-a's failure.
        sinon.assert.calledWith(deleteSpy, 'orphan-a');
        sinon.assert.calledWith(deleteSpy, 'orphan-b');
    });
});
