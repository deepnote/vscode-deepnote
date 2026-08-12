import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, EventEmitter, Uri } from 'vscode';

import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { logger } from '../../../platform/logging';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IIntegrationEnvLiveRefresher, IIntegrationStorage } from './types';
import { IntegrationEnvRefreshHandler } from './integrationEnvRefreshHandler';
import { createMockNotebook } from '../deepnoteTestHelpers';

suite('IntegrationEnvRefreshHandler', () => {
    let handler: IntegrationEnvRefreshHandler;
    let integrationStorage: IIntegrationStorage;
    let liveRefresher: IIntegrationEnvLiveRefresher;
    let disposables: IDisposable[];
    let onDidChangeIntegrations: EventEmitter<void>;

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        integrationStorage = mock<IIntegrationStorage>();
        liveRefresher = mock<IIntegrationEnvLiveRefresher>();
        onDidChangeIntegrations = new EventEmitter<void>();
        disposables.push(onDidChangeIntegrations);

        when(integrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrations.event);
        when(liveRefresher.refresh(anything(), anything())).thenResolve();

        handler = new IntegrationEnvRefreshHandler(instance(integrationStorage), instance(liveRefresher), disposables);
    });

    teardown(() => {
        sinon.restore();
        disposables = dispose(disposables);
    });

    test('passes only Deepnote notebooks to the refresher when integrations change', async () => {
        const deepnote = createMockNotebook({ uri: Uri.file('/a.deepnote') });
        const jupyter = createMockNotebook({ notebookType: 'jupyter-notebook', uri: Uri.file('/b.ipynb') });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([deepnote, jupyter]);

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(liveRefresher.refresh(anything(), anything())).once();
        const [refreshed, trigger] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [deepnote]);
        assert.strictEqual(trigger, 'integration_config', 'a SecretStorage change is not an env-file change');
    });

    test('refreshes multiple Deepnote notebooks in a single call', async () => {
        const notebook1 = createMockNotebook({ uri: Uri.file('/test1.deepnote') });
        const notebook2 = createMockNotebook({ uri: Uri.file('/test2.deepnote') });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(liveRefresher.refresh(anything(), anything())).once();
        const [refreshed] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [notebook1, notebook2]);
    });

    test('catches and logs a rejected refresh instead of propagating it', async () => {
        const notebook = createMockNotebook({ uri: Uri.file('/test.deepnote') });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(liveRefresher.refresh(anything(), anything())).thenReject(new Error('refresh boom'));
        const errorStub = sinon.stub(logger, 'error');

        handler.activate();
        onDidChangeIntegrations.fire();

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(liveRefresher.refresh(anything(), anything())).once();
        assert.strictEqual(errorStub.callCount, 1, 'the fire-and-forget rejection must be caught and logged');
    });
});
