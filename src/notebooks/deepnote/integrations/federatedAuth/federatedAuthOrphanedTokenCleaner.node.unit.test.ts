import { assert } from 'chai';
import { Disposable } from 'vscode';

import { FederatedAuthOrphanedTokenCleaner } from './federatedAuthOrphanedTokenCleaner.node';
import { IDisposable } from '../../../../platform/common/types';
import { dispose } from '../../../../platform/common/utils/lifecycle';
import {
    buildGoogleOauthIntegration,
    buildTokenEntry,
    createFakeIntegrationStorage,
    createFakeTokenStorage,
    settleAsyncHandlers
} from './federatedAuthTestHelpers';

suite('FederatedAuthOrphanedTokenCleaner', () => {
    let disposables: IDisposable[];
    let fakeIntegration: ReturnType<typeof createFakeIntegrationStorage>;
    let fakeToken: ReturnType<typeof createFakeTokenStorage>;

    function fireChangeAndWait(): Promise<void> {
        fakeIntegration.onDidChangeIntegrations.fire();
        return settleAsyncHandlers();
    }

    setup(() => {
        disposables = [];
        fakeIntegration = createFakeIntegrationStorage();
        fakeToken = createFakeTokenStorage();
        disposables.push(new Disposable(() => fakeIntegration.onDidChangeIntegrations.dispose()));
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('does not call delete when every stored token has a matching integration', async () => {
        fakeIntegration.addIntegration(buildGoogleOauthIntegration({ id: 'bq-1' }));
        fakeIntegration.addIntegration(buildGoogleOauthIntegration({ id: 'bq-2' }));
        fakeToken.tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        fakeToken.tokens.set('bq-2', buildTokenEntry({ integrationId: 'bq-2' }));

        new FederatedAuthOrphanedTokenCleaner(fakeToken.storage, fakeIntegration.storage, disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(fakeToken.deletedIds, []);
    });

    test('deletes tokens for integrations that no longer exist', async () => {
        fakeIntegration.addIntegration(buildGoogleOauthIntegration({ id: 'bq-1' }));
        fakeToken.tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        fakeToken.tokens.set('orphan-a', buildTokenEntry({ integrationId: 'orphan-a' }));
        fakeToken.tokens.set('orphan-b', buildTokenEntry({ integrationId: 'orphan-b' }));

        new FederatedAuthOrphanedTokenCleaner(fakeToken.storage, fakeIntegration.storage, disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(fakeToken.deletedIds.sort(), ['orphan-a', 'orphan-b']);
    });

    test('no-op when there are no stored tokens at all', async () => {
        fakeIntegration.addIntegration(buildGoogleOauthIntegration({ id: 'bq-1' }));

        new FederatedAuthOrphanedTokenCleaner(fakeToken.storage, fakeIntegration.storage, disposables);

        await fireChangeAndWait();

        assert.deepStrictEqual(fakeToken.deletedIds, []);
    });

    test('continues deleting other orphans when one delete fails', async () => {
        fakeIntegration.addIntegration(buildGoogleOauthIntegration({ id: 'bq-1' }));
        fakeToken = createFakeTokenStorage({ throwOnDelete: new Set(['orphan-a']) });
        fakeToken.tokens.set('bq-1', buildTokenEntry({ integrationId: 'bq-1' }));
        fakeToken.tokens.set('orphan-a', buildTokenEntry({ integrationId: 'orphan-a' }));
        fakeToken.tokens.set('orphan-b', buildTokenEntry({ integrationId: 'orphan-b' }));

        new FederatedAuthOrphanedTokenCleaner(fakeToken.storage, fakeIntegration.storage, disposables);

        await fireChangeAndWait();

        // Both attempts must have happened, even after orphan-a's failure.
        assert.deepStrictEqual(fakeToken.deletedIds.sort(), ['orphan-a', 'orphan-b']);
    });
});
