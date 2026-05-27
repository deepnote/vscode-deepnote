import { Disposable, EventEmitter, NotebookDocument, Uri } from 'vscode';
import { anyString, instance, mock, verify, when } from 'ts-mockito';

import { FederatedAuthKernelRestartBridge } from './federatedAuthKernelRestartBridge.node';
import { IDeepnoteNotebookManager } from '../../../types';
import { IDisposable } from '../../../../platform/common/types';
import { IFederatedAuthTokenStorage } from '../types';
import { IKernel, IKernelProvider } from '../../../../kernels/types';
import { dispose } from '../../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';
import { createMockProject, settleAsyncHandlers } from './federatedAuthTestHelpers';

suite('FederatedAuthKernelRestartBridge', () => {
    let bridge: FederatedAuthKernelRestartBridge;
    let tokenStorage: IFederatedAuthTokenStorage;
    let kernelProvider: IKernelProvider;
    let notebookManager: IDeepnoteNotebookManager;
    let disposables: IDisposable[];
    let onDidChangeTokens: EventEmitter<string>;

    function createMockNotebook(notebookType: string, uri: Uri, projectId?: string): NotebookDocument {
        const notebook = mock<NotebookDocument>();
        when(notebook.notebookType).thenReturn(notebookType);
        when(notebook.uri).thenReturn(uri);
        when(notebook.metadata).thenReturn(projectId ? { deepnoteProjectId: projectId } : {});
        return instance(notebook);
    }

    function mkKernel(opts: { startedAtLeastOnce?: boolean; restartRejects?: Error } = {}): IKernel {
        const kernel = mock<IKernel>();
        when(kernel.startedAtLeastOnce).thenReturn(opts.startedAtLeastOnce ?? true);
        if (opts.restartRejects) {
            when(kernel.restart()).thenReject(opts.restartRejects);
        } else {
            when(kernel.restart()).thenResolve();
        }
        return kernel;
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        tokenStorage = mock<IFederatedAuthTokenStorage>();
        kernelProvider = mock<IKernelProvider>();
        notebookManager = mock<IDeepnoteNotebookManager>();
        onDidChangeTokens = new EventEmitter<string>();
        disposables.push(onDidChangeTokens);

        when(tokenStorage.onDidChangeTokens).thenReturn(onDidChangeTokens.event);

        bridge = new FederatedAuthKernelRestartBridge(
            instance(tokenStorage),
            instance(kernelProvider),
            instance(notebookManager),
            disposables
        );
        bridge.activate();
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('restarts only the affected notebook when one of many references the integration', async () => {
        const notebookA = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const notebookB = createMockNotebook('deepnote', Uri.file('/b.ipynb'), 'project-b');
        const kernelA = mkKernel();
        const kernelB = mkKernel();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(kernelProvider.get(notebookA)).thenReturn(instance(kernelA));
        when(kernelProvider.get(notebookB)).thenReturn(instance(kernelB));
        // Only project A references 'bq-shared'.
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-shared']));
        when(notebookManager.getOriginalProject('project-b')).thenReturn(createMockProject('project-b', ['other-bq']));

        onDidChangeTokens.fire('bq-shared');
        await settleAsyncHandlers();

        verify(kernelA.restart()).once();
        verify(kernelB.restart()).never();
    });

    test('restarts both kernels when two notebooks reference the same integration', async () => {
        const notebookA = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const notebookB = createMockNotebook('deepnote', Uri.file('/b.ipynb'), 'project-b');
        const kernelA = mkKernel();
        const kernelB = mkKernel();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(kernelProvider.get(notebookA)).thenReturn(instance(kernelA));
        when(kernelProvider.get(notebookB)).thenReturn(instance(kernelB));
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-shared']));
        when(notebookManager.getOriginalProject('project-b')).thenReturn(createMockProject('project-b', ['bq-shared']));

        onDidChangeTokens.fire('bq-shared');
        await settleAsyncHandlers();

        verify(kernelA.restart()).once();
        verify(kernelB.restart()).once();
    });

    (
        [
            [
                'non-Deepnote notebooks',
                () => createMockNotebook('jupyter-notebook', Uri.file('/a.ipynb'), 'project-a'),
                () => mkKernel(),
                () => createMockProject('project-a', ['bq-1'])
            ],
            [
                'notebooks whose kernel has not started',
                () => createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a'),
                () => mkKernel({ startedAtLeastOnce: false }),
                () => createMockProject('project-a', ['bq-1'])
            ],
            [
                'notebooks without project metadata',
                () => createMockNotebook('deepnote', Uri.file('/a.ipynb')),
                () => mkKernel(),
                () => undefined
            ]
        ] as const
    ).forEach(([label, buildNotebook, buildKernel, buildProject]) => {
        test(`skips ${label}`, async () => {
            const notebook = buildNotebook();
            const kernel = buildKernel();
            const project = buildProject();

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(kernelProvider.get(notebook)).thenReturn(instance(kernel));
            if (project) {
                when(notebookManager.getOriginalProject('project-a')).thenReturn(project);
            }

            onDidChangeTokens.fire('bq-1');
            await settleAsyncHandlers();

            verify(kernel.restart()).never();
            if (!project) {
                verify(notebookManager.getOriginalProject(anyString())).never();
            }
        });
    });

    test('continues restarting other kernels when one fails', async () => {
        const notebookA = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const notebookB = createMockNotebook('deepnote', Uri.file('/b.ipynb'), 'project-b');
        const kernelA = mkKernel({ restartRejects: new Error('boom') });
        const kernelB = mkKernel();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(kernelProvider.get(notebookA)).thenReturn(instance(kernelA));
        when(kernelProvider.get(notebookB)).thenReturn(instance(kernelB));
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-shared']));
        when(notebookManager.getOriginalProject('project-b')).thenReturn(createMockProject('project-b', ['bq-shared']));

        onDidChangeTokens.fire('bq-shared');
        await settleAsyncHandlers();

        verify(kernelA.restart()).once();
        verify(kernelB.restart()).once();
    });
});
