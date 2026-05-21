import { assert } from 'chai';
import { anyString, anything, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, EventEmitter, NotebookDocument, Uri } from 'vscode';

import { FederatedAuthKernelRestartBridge } from './federatedAuthKernelRestartBridge.node';
import { IDeepnoteNotebookManager } from '../../../types';
import { IDisposable } from '../../../../platform/common/types';
import { IFederatedAuthTokenStorage } from '../types';
import { IKernel, IKernelProvider } from '../../../../kernels/types';
import { dispose } from '../../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';
import type { DeepnoteProject } from '../../../../platform/deepnote/deepnoteTypes';

suite('FederatedAuthKernelRestartBridge', () => {
    let bridge: FederatedAuthKernelRestartBridge;
    let tokenStorage: IFederatedAuthTokenStorage;
    let kernelProvider: IKernelProvider;
    let notebookManager: IDeepnoteNotebookManager;
    let disposables: IDisposable[];
    let onDidChangeTokens: EventEmitter<string>;

    function createMockProject(projectId: string, integrationIds: string[] = []): DeepnoteProject {
        return {
            metadata: {
                createdAt: '2023-01-01T00:00:00Z',
                modifiedAt: '2023-01-02T00:00:00Z'
            },
            project: {
                id: projectId,
                name: 'Test Project',
                notebooks: [],
                integrations: integrationIds.map((id) => ({ id, name: id, type: 'big-query' as const }))
            },
            version: '1.0.0'
        };
    }

    function createMockNotebook(notebookType: string, uri: Uri, projectId?: string): NotebookDocument {
        const notebook = mock<NotebookDocument>();
        when(notebook.notebookType).thenReturn(notebookType);
        when(notebook.uri).thenReturn(uri);
        when(notebook.metadata).thenReturn(projectId ? { deepnoteProjectId: projectId } : {});
        return instance(notebook);
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

    test('does not restart any kernel when no notebook references the integration', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const kernel = mock<IKernel>();
        when(kernel.startedAtLeastOnce).thenReturn(true);
        when(kernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernel));
        // Project A doesn't reference 'orphan-integration'.
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['other-bq']));

        onDidChangeTokens.fire('orphan-integration');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernel.restart()).never();
    });

    test('restarts only the affected notebook when one of many references the integration', async () => {
        const notebookA = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const notebookB = createMockNotebook('deepnote', Uri.file('/b.ipynb'), 'project-b');
        const kernelA = mock<IKernel>();
        const kernelB = mock<IKernel>();
        when(kernelA.startedAtLeastOnce).thenReturn(true);
        when(kernelA.restart()).thenResolve();
        when(kernelB.startedAtLeastOnce).thenReturn(true);
        when(kernelB.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(kernelProvider.get(notebookA)).thenReturn(instance(kernelA));
        when(kernelProvider.get(notebookB)).thenReturn(instance(kernelB));
        // Only project A references 'bq-shared'.
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-shared']));
        when(notebookManager.getOriginalProject('project-b')).thenReturn(createMockProject('project-b', ['other-bq']));

        onDidChangeTokens.fire('bq-shared');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernelA.restart()).once();
        verify(kernelB.restart()).never();
    });

    test('restarts both kernels when two notebooks reference the same integration', async () => {
        const notebookA = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const notebookB = createMockNotebook('deepnote', Uri.file('/b.ipynb'), 'project-b');
        const kernelA = mock<IKernel>();
        const kernelB = mock<IKernel>();
        when(kernelA.startedAtLeastOnce).thenReturn(true);
        when(kernelA.restart()).thenResolve();
        when(kernelB.startedAtLeastOnce).thenReturn(true);
        when(kernelB.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(kernelProvider.get(notebookA)).thenReturn(instance(kernelA));
        when(kernelProvider.get(notebookB)).thenReturn(instance(kernelB));
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-shared']));
        when(notebookManager.getOriginalProject('project-b')).thenReturn(createMockProject('project-b', ['bq-shared']));

        onDidChangeTokens.fire('bq-shared');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernelA.restart()).once();
        verify(kernelB.restart()).once();
    });

    test('skips non-Deepnote notebooks', async () => {
        const notebook = createMockNotebook('jupyter-notebook', Uri.file('/a.ipynb'), 'project-a');
        const kernel = mock<IKernel>();
        when(kernel.startedAtLeastOnce).thenReturn(true);
        when(kernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernel));
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-1']));

        onDidChangeTokens.fire('bq-1');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernel.restart()).never();
    });

    test('skips notebooks whose kernel has not started', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const kernel = mock<IKernel>();
        when(kernel.startedAtLeastOnce).thenReturn(false);
        when(kernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernel));
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-1']));

        onDidChangeTokens.fire('bq-1');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernel.restart()).never();
    });

    test('continues restarting other kernels when one fails', async () => {
        const notebookA = createMockNotebook('deepnote', Uri.file('/a.ipynb'), 'project-a');
        const notebookB = createMockNotebook('deepnote', Uri.file('/b.ipynb'), 'project-b');
        const kernelA = mock<IKernel>();
        const kernelB = mock<IKernel>();
        when(kernelA.startedAtLeastOnce).thenReturn(true);
        when(kernelA.restart()).thenReject(new Error('boom'));
        when(kernelB.startedAtLeastOnce).thenReturn(true);
        when(kernelB.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(kernelProvider.get(notebookA)).thenReturn(instance(kernelA));
        when(kernelProvider.get(notebookB)).thenReturn(instance(kernelB));
        when(notebookManager.getOriginalProject('project-a')).thenReturn(createMockProject('project-a', ['bq-shared']));
        when(notebookManager.getOriginalProject('project-b')).thenReturn(createMockProject('project-b', ['bq-shared']));

        onDidChangeTokens.fire('bq-shared');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernelA.restart()).once();
        verify(kernelB.restart()).once();
    });

    test('handles notebooks without project metadata gracefully', async () => {
        const notebook = createMockNotebook('deepnote', Uri.file('/a.ipynb'));
        const kernel = mock<IKernel>();
        when(kernel.startedAtLeastOnce).thenReturn(true);
        when(kernel.restart()).thenResolve();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernel));

        onDidChangeTokens.fire('bq-1');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernel.restart()).never();
        verify(notebookManager.getOriginalProject(anyString())).never();
    });

    test('registers its onDidChangeTokens subscription with IDisposableRegistry', () => {
        // Construct a fresh bridge inside the test so we can measure
        // disposables.length before vs after — the setup() block's bridge
        // construction is not counted here.
        const initialCount = disposables.length;
        new FederatedAuthKernelRestartBridge(
            instance(tokenStorage),
            instance(kernelProvider),
            instance(notebookManager),
            disposables
        );
        assert.ok(
            disposables.length > initialCount,
            `expected bridge to push a disposable; before=${initialCount} after=${disposables.length}`
        );
    });

    test('ignores extra side effects: does not call kernelProvider.get when no notebooks are open', async () => {
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        onDidChangeTokens.fire('bq-1');

        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(kernelProvider.get(anything())).never();
    });
});
