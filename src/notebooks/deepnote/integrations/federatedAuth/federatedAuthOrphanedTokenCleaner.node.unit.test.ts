import { assert } from 'chai';
import { Disposable, EventEmitter } from 'vscode';

import { FederatedAuthOrphanedTokenCleaner } from './federatedAuthOrphanedTokenCleaner.node';
import { IDisposable } from '../../../../platform/common/types';
import { IFederatedAuthTokenStorage } from '../types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { dispose } from '../../../../platform/common/utils/lifecycle';
import { buildGoogleOauthIntegration, settleAsyncHandlers } from './federatedAuthTestHelpers';

suite('FederatedAuthOrphanedTokenCleaner', () => {
    let onDidChangeIntegrations: EventEmitter<void>;
    let disposables: IDisposable[];

    let integrationIds: Set<string>;
    let storedTokenIds: Set<string>;
    let deletedTokenIds: string[];

    function buildIntegrationStorage(): IIntegrationStorage {
        return {
            getAll: async () => Array.from(integrationIds).map((id) => buildGoogleOauthIntegration({ id })),
            onDidChangeIntegrations: onDidChangeIntegrations.event
        } as unknown as IIntegrationStorage;
    }

    function buildTokenStorage(opts: { throwOnDelete?: Set<string> } = {}): IFederatedAuthTokenStorage {
        return {
            listIntegrationIds: async () => Array.from(storedTokenIds),
            delete: async (id: string) => {
                deletedTokenIds.push(id);
                if (opts.throwOnDelete?.has(id)) {
                    throw new Error('boom');
                }
                storedTokenIds.delete(id);
            }
        } as unknown as IFederatedAuthTokenStorage;
    }

    function fireChangeAndWait(): Promise<void> {
        onDidChangeIntegrations.fire();
        return settleAsyncHandlers();
    }

    setup(() => {
        disposables = [];
        onDidChangeIntegrations = new EventEmitter<void>();
        disposables.push(new Disposable(() => onDidChangeIntegrations.dispose()));

        integrationIds = new Set();
        storedTokenIds = new Set();
        deletedTokenIds = [];
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('does not call delete when every stored token has a matching integration', async () => {
        integrationIds.add('bq-1');
        integrationIds.add('bq-2');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('bq-2');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds, []);
    });

    test('deletes tokens for integrations that no longer exist', async () => {
        integrationIds.add('bq-1');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('orphan-a');
        storedTokenIds.add('orphan-b');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds.sort(), ['orphan-a', 'orphan-b']);
    });

    test('no-op when there are no stored tokens at all', async () => {
        integrationIds.add('bq-1');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds, []);
    });

    test('continues deleting other orphans when one delete fails', async () => {
        integrationIds.add('bq-1');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('orphan-a');
        storedTokenIds.add('orphan-b');

        new FederatedAuthOrphanedTokenCleaner(
            buildTokenStorage({ throwOnDelete: new Set(['orphan-a']) }),
            buildIntegrationStorage(),
            disposables
        );

        await fireChangeAndWait();

        // Both attempts must have happened, even after orphan-a's failure.
        assert.deepStrictEqual(deletedTokenIds.sort(), ['orphan-a', 'orphan-b']);
    });
});
