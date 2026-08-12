import { assert } from 'chai';
import { anything, capture, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, NotebookDocument, Uri } from 'vscode';

import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { ITelemetryService } from '../../../platform/analytics/types';
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
    let kernelExecution: INotebookKernelExecution;
    let analytics: ITelemetryService;
    let disposables: IDisposable[];

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        kernelProvider = mock<IKernelProvider>();

        // Every notebook resolves to the same execution mock, so call counts below are totals across notebooks.
        kernelExecution = mock<INotebookKernelExecution>();
        when(kernelExecution.executeHidden(anything())).thenResolve([]);
        when(kernelProvider.getKernelExecution(anything())).thenReturn(instance(kernelExecution));

        analytics = mock<ITelemetryService>();

        refresher = new IntegrationEnvLiveRefresher(instance(kernelProvider), instance(analytics));
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

        await refresher.refresh([notebook], 'env_file');

        verify(kernelExecution.executeHidden(anything())).once();
        const [code] = capture(kernelExecution.executeHidden).first();
        assert.strictEqual(
            code,
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

        await refresher.refresh([notebook], 'env_file');

        verify(kernelExecution.executeHidden(anything())).never();
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('skips kernels that have not started and shows no status-bar message', async () => {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(Uri.file('/ws/a.deepnote'));
        const notebook = instance(notebookMock);

        const kernelMock = mock<IKernel>();
        when(kernelMock.startedAtLeastOnce).thenReturn(false);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernelMock));

        await refresher.refresh([notebook], 'env_file');

        verify(kernelExecution.executeHidden(anything())).never();
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('does not show a status-bar message when the refresh snippet produces an error output', async () => {
        const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        when(kernelExecution.executeHidden(anything())).thenResolve([
            { output_type: 'error', ename: 'RuntimeError', evalue: 'boom', traceback: [] }
        ]);

        await refresher.refresh([notebook], 'env_file');

        verify(kernelExecution.executeHidden(anything())).once(); // the snippet still runs; its output signals failure
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('continues to the next notebook when one executeHidden throws, and still notifies for the success', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));
        when(kernelExecution.executeHidden(anything())).thenReject(new Error('kernel exploded')).thenResolve([]);

        await refresher.refresh([notebookA, notebookB], 'env_file');

        verify(kernelExecution.executeHidden(anything())).twice(); // a throw on the first must not stop the second
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });

    suite('refresh_integration_env telemetry', () => {
        test('reports the counts and the trigger for a clean refresh, with no failureKind', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            await refresher.refresh([notebook], 'integration_config');

            verify(
                analytics.trackEvent(
                    deepEqual({
                        eventName: 'refresh_integration_env',
                        properties: {
                            attemptedCount: 1,
                            failedCount: 0,
                            refreshedCount: 1,
                            trigger: 'integration_config'
                        }
                    })
                )
            ).once();
        });

        test('emits nothing when every notebook was skipped', async () => {
            // Otherwise every save of a .deepnote.env.yaml with no kernel running would emit an event.
            const notebookMock = mock<NotebookDocument>();
            when(notebookMock.uri).thenReturn(Uri.file('/ws/a.deepnote'));
            const notebook = instance(notebookMock);
            when(kernelProvider.get(notebook)).thenReturn(undefined);

            await refresher.refresh([notebook], 'env_file');

            verify(analytics.trackEvent(anything())).never();
        });

        test('counts a skipped notebook as attempted but neither refreshed nor failed', async () => {
            const running = createRunningNotebook(Uri.file('/ws/a.deepnote'));
            const skippedMock = mock<NotebookDocument>();
            when(skippedMock.uri).thenReturn(Uri.file('/ws/b.deepnote'));
            const skipped = instance(skippedMock);
            when(kernelProvider.get(skipped)).thenReturn(undefined);

            await refresher.refresh([running, skipped], 'env_file');

            verify(
                analytics.trackEvent(
                    deepEqual({
                        eventName: 'refresh_integration_env',
                        properties: { attemptedCount: 2, failedCount: 0, refreshedCount: 1, trigger: 'env_file' }
                    })
                )
            ).once();
        });

        test('distinguishes a snippet error from a rejected execution', async () => {
            const snippetError = createRunningNotebook(Uri.file('/ws/a.deepnote'));
            when(kernelExecution.executeHidden(anything())).thenResolve([
                { output_type: 'error', ename: 'RuntimeError', evalue: 'boom', traceback: [] }
            ]);

            await refresher.refresh([snippetError], 'env_file');

            verify(
                analytics.trackEvent(
                    deepEqual({
                        eventName: 'refresh_integration_env',
                        properties: {
                            attemptedCount: 1,
                            failedCount: 1,
                            refreshedCount: 0,
                            trigger: 'env_file',
                            failureKind: 'snippet_error'
                        }
                    })
                )
            ).once();

            const rejected = createRunningNotebook(Uri.file('/ws/b.deepnote'));
            when(kernelExecution.executeHidden(anything())).thenReject(new Error('kernel exploded'));

            await refresher.refresh([rejected], 'integration_config');

            verify(
                analytics.trackEvent(
                    deepEqual({
                        eventName: 'refresh_integration_env',
                        properties: {
                            attemptedCount: 1,
                            failedCount: 1,
                            refreshedCount: 0,
                            trigger: 'integration_config',
                            failureKind: 'execution_failed'
                        }
                    })
                )
            ).once();
        });
    });

    test('refreshes kernels in parallel: both executions start before either resolves', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));

        // First execution resolves only once the second has been invoked; a sequential loop would deadlock (and time out).
        let markSecondInvoked!: () => void;
        const secondInvoked = new Promise<void>((resolve) => (markSecondInvoked = resolve));
        when(kernelExecution.executeHidden(anything()))
            .thenCall(() => secondInvoked.then(() => []))
            .thenCall(() => {
                markSecondInvoked();

                return Promise.resolve([]);
            });

        await refresher.refresh([notebookA, notebookB], 'env_file');

        verify(kernelExecution.executeHidden(anything())).twice(); // both started kernels are refreshed
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });
});
