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

    test('does not call delete when every stored token has a matching integration', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        integrations.set('bq-2', buildGoogleOauthIntegration({ id: 'bq-2' }));
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        tokens.set('bq-2', buildTokenEntry({ integrationId: 'bq-2' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        await fireChangeAndWait();

        sinon.assert.notCalled(deleteSpy);
    });

    test('deletes tokens for integrations that no longer exist', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        tokens.set('orphan-a', buildTokenEntry({ integrationId: 'orphan-a' }));
        tokens.set('orphan-b', buildTokenEntry({ integrationId: 'orphan-b' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        await fireChangeAndWait();

        sinon.assert.calledWith(deleteSpy, 'orphan-a');
        sinon.assert.calledWith(deleteSpy, 'orphan-b');
        sinon.assert.neverCalledWith(deleteSpy, 'bq-1');
    });

    test('no-op when there are no stored tokens at all', async () => {
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        await fireChangeAndWait();

        sinon.assert.notCalled(deleteSpy);
    });

    test('continues deleting other orphans when one delete fails', async () => {
        tokenStorage = buildTokenStorage(new Set(['orphan-a']));
        integrations.set('bq-1', buildGoogleOauthIntegration({ id: 'bq-1' }));
        tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        tokens.set('orphan-a', buildTokenEntry({ integrationId: 'orphan-a' }));
        tokens.set('orphan-b', buildTokenEntry({ integrationId: 'orphan-b' }));

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, integrationStorage, disposables);

        await fireChangeAndWait();

        // Both attempts must have happened, even after orphan-a's failure.
        sinon.assert.calledWith(deleteSpy, 'orphan-a');
        sinon.assert.calledWith(deleteSpy, 'orphan-b');
    });
});
