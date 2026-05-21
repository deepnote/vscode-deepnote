import { assert } from 'chai';
import { Disposable, EventEmitter } from 'vscode';

import { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';
import { FederatedAuthOrphanedTokenCleaner } from './federatedAuthOrphanedTokenCleaner.node';
import { IDisposable } from '../../../../platform/common/types';
import { IFederatedAuthTokenStorage } from '../types';
import { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import { dispose } from '../../../../platform/common/utils/lifecycle';

suite('FederatedAuthOrphanedTokenCleaner', () => {
    let onDidChangeIntegrations: EventEmitter<void>;
    let disposables: IDisposable[];

    let storedIntegrations: Map<string, ConfigurableDatabaseIntegrationConfig>;
    let storedTokenIds: Set<string>;
    let deletedTokenIds: string[];

    function buildIntegrationStorage(): IIntegrationStorage {
        return {
            getAll: async () => Array.from(storedIntegrations.values()),
            onDidChangeIntegrations: onDidChangeIntegrations.event
        } as unknown as IIntegrationStorage;
    }

    function buildTokenStorage(): IFederatedAuthTokenStorage {
        return {
            listIntegrationIds: async () => Array.from(storedTokenIds),
            delete: async (id: string) => {
                storedTokenIds.delete(id);
                deletedTokenIds.push(id);
            }
        } as unknown as IFederatedAuthTokenStorage;
    }

    function addIntegration(id: string): void {
        storedIntegrations.set(id, {
            id,
            name: id,
            type: 'big-query',
            metadata: {} as never
        } as ConfigurableDatabaseIntegrationConfig);
    }

    function fireChangeAndWait(): Promise<void> {
        onDidChangeIntegrations.fire();
        return new Promise((resolve) => setTimeout(resolve, 10));
    }

    setup(() => {
        disposables = [];
        onDidChangeIntegrations = new EventEmitter<void>();
        disposables.push(new Disposable(() => onDidChangeIntegrations.dispose()));

        storedIntegrations = new Map();
        storedTokenIds = new Set();
        deletedTokenIds = [];
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('does not call delete when every stored token has a matching integration', async () => {
        addIntegration('bq-1');
        addIntegration('bq-2');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('bq-2');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds, []);
    });

    test('deletes tokens for integrations that no longer exist', async () => {
        addIntegration('bq-1');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('orphan-a');
        storedTokenIds.add('orphan-b');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds.sort(), ['orphan-a', 'orphan-b']);
    });

    test('deletes all tokens when the integration list is cleared', async () => {
        // No integrations.
        storedTokenIds.add('orphan-1');
        storedTokenIds.add('orphan-2');
        storedTokenIds.add('orphan-3');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds.sort(), ['orphan-1', 'orphan-2', 'orphan-3']);
    });

    test('no-op when there are no stored tokens at all', async () => {
        addIntegration('bq-1');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(deletedTokenIds, []);
    });

    test('handles repeated fires correctly', async () => {
        addIntegration('bq-1');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('orphan');

        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);

        await fireChangeAndWait();
        assert.deepStrictEqual(deletedTokenIds, ['orphan']);

        deletedTokenIds.length = 0;
        await fireChangeAndWait();

        // Second fire: no new orphans.
        assert.deepStrictEqual(deletedTokenIds, []);
    });

    test('continues deleting other orphans when one delete fails', async () => {
        addIntegration('bq-1');
        storedTokenIds.add('bq-1');
        storedTokenIds.add('orphan-a');
        storedTokenIds.add('orphan-b');

        const tokenStorage: IFederatedAuthTokenStorage = {
            listIntegrationIds: async () => Array.from(storedTokenIds),
            delete: async (id: string) => {
                deletedTokenIds.push(id);
                if (id === 'orphan-a') {
                    throw new Error('boom');
                }
                storedTokenIds.delete(id);
            }
        } as unknown as IFederatedAuthTokenStorage;

        new FederatedAuthOrphanedTokenCleaner(tokenStorage, buildIntegrationStorage(), disposables);

        await fireChangeAndWait();

        // Both attempts must have happened, even after orphan-a's failure.
        assert.deepStrictEqual(deletedTokenIds.sort(), ['orphan-a', 'orphan-b']);
    });

    test('registers its subscription with IDisposableRegistry', () => {
        const initialCount = disposables.length;
        new FederatedAuthOrphanedTokenCleaner(buildTokenStorage(), buildIntegrationStorage(), disposables);
        assert.ok(
            disposables.length > initialCount,
            `expected cleaner to push a disposable; before=${initialCount} after=${disposables.length}`
        );
    });
});
