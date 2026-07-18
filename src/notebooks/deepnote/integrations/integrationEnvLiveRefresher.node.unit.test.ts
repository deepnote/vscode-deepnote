import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, NotebookDocument, Uri } from 'vscode';

import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IntegrationEnvLiveRefresher } from './integrationEnvLiveRefresher.node';

// Must match REFRESH_INTEGRATION_ENV_SNIPPET in integrationEnvLiveRefresher.node.ts exactly (real newline).
const EXPECTED_SNIPPET = `import deepnote_toolkit
deepnote_toolkit.set_integration_env()`;

const EXPECTED_NOTIFICATION = 'Deepnote integration environment updated.';

suite('IntegrationEnvLiveRefresher', () => {
    let refresher: IntegrationEnvLiveRefresher;
    let kernelProvider: IKernelProvider;
    let executeHiddenSpy: sinon.SinonStub;
    let disposables: IDisposable[];

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        kernelProvider = mock<IKernelProvider>();

        executeHiddenSpy = sinon.stub().resolves([]);
        when(kernelProvider.getKernelExecution(anything())).thenReturn({
            executeHidden: executeHiddenSpy
        } as unknown as INotebookKernelExecution);

        refresher = new IntegrationEnvLiveRefresher(instance(kernelProvider));
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    /** A notebook whose kernel is started; `kernelProvider.get(notebook)` returns it. */
    function createRunningNotebook(uri: Uri): NotebookDocument {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(uri);
        const notebook = instance(notebookMock);

        const kernelMock = mock<IKernel>();
        when(kernelMock.startedAtLeastOnce).thenReturn(true);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernelMock));

        return notebook;
    }

    test('runs the exact refresh snippet in a started kernel and shows one status-bar message', async () => {
        const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

        await refresher.refresh([notebook]);

        assert.strictEqual(executeHiddenSpy.callCount, 1, 'the refresh snippet should run once');
        assert.strictEqual(
            executeHiddenSpy.firstCall.args[0],
            EXPECTED_SNIPPET,
            'executeHidden must receive the toolkit set_integration_env() snippet verbatim'
        );

        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
        const [message] = capture(mockedVSCodeNamespaces.window.setStatusBarMessage).last();
        assert.strictEqual(message, EXPECTED_NOTIFICATION);
    });

    test('skips notebooks with no kernel and shows no status-bar message', async () => {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(Uri.file('/ws/a.deepnote'));
        const notebook = instance(notebookMock);
        when(kernelProvider.get(notebook)).thenReturn(undefined);

        await refresher.refresh([notebook]);

        assert.strictEqual(executeHiddenSpy.callCount, 0, 'no kernel means nothing to refresh');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('skips kernels that have not started and shows no status-bar message', async () => {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(Uri.file('/ws/a.deepnote'));
        const notebook = instance(notebookMock);

        const kernelMock = mock<IKernel>();
        when(kernelMock.startedAtLeastOnce).thenReturn(false);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernelMock));

        await refresher.refresh([notebook]);

        assert.strictEqual(executeHiddenSpy.callCount, 0, 'a kernel that has not started must not be executed against');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('does not show a status-bar message when the refresh snippet produces an error output', async () => {
        const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        executeHiddenSpy.resolves([{ output_type: 'error', ename: 'RuntimeError', evalue: 'boom', traceback: [] }]);

        await refresher.refresh([notebook]);

        assert.strictEqual(executeHiddenSpy.callCount, 1, 'the snippet still runs, but its output signals failure');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('shows exactly one status-bar message when multiple kernels are refreshed', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));

        await refresher.refresh([notebookA, notebookB]);

        assert.strictEqual(executeHiddenSpy.callCount, 2, 'both started kernels are refreshed');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });

    test('continues to the next notebook when one executeHidden throws, and still notifies for the success', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));
        executeHiddenSpy.onFirstCall().rejects(new Error('kernel exploded'));
        executeHiddenSpy.onSecondCall().resolves([]);

        await refresher.refresh([notebookA, notebookB]);

        assert.strictEqual(executeHiddenSpy.callCount, 2, 'a throw on the first must not stop the second');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });

    test('refreshes kernels in parallel: both executions start before either resolves', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));

        // First execution resolves only once the second has been invoked; a sequential loop would deadlock (and time out).
        let markSecondInvoked!: () => void;
        const secondInvoked = new Promise<void>((resolve) => (markSecondInvoked = resolve));
        executeHiddenSpy.onFirstCall().callsFake(() => secondInvoked.then(() => []));
        executeHiddenSpy.onSecondCall().callsFake(() => {
            markSecondInvoked();

            return Promise.resolve([]);
        });

        await refresher.refresh([notebookA, notebookB]);

        assert.strictEqual(executeHiddenSpy.callCount, 2, 'both started kernels are refreshed');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });
});
