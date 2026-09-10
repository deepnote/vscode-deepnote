import { anything, instance, mock, verify, when } from 'ts-mockito';
import { EventEmitter, NotebookDocument, NotebookEditor, Uri } from 'vscode';
import type { KernelMessage } from '@jupyterlab/services';

import { ActiveEditorContextService } from './activeEditorContext';
import { IKernel, IKernelProvider, INotebookKernelExecution, KernelConnectionMetadata } from '../../kernels/types';
import { IJupyterServerProviderRegistry } from '../../kernels/jupyter/types';
import { IControllerRegistration, IVSCodeNotebookController } from '../../notebooks/controllers/types';
import { EditorContexts } from '../../platform/common/constants';
import { IDisposable } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

function makeNotebook(notebookType: string, fileName: string): NotebookDocument {
    return {
        notebookType,
        uri: Uri.file(`/workspace/${fileName}`),
        metadata: {},
        cellCount: 1
    } as unknown as NotebookDocument;
}

function editorFor(notebook: NotebookDocument): NotebookEditor {
    return { notebook } as unknown as NotebookEditor;
}

suite('ActiveEditorContextService', () => {
    let service: ActiveEditorContextService;
    let disposables: IDisposable[];
    let kernelProvider: IKernelProvider;
    let controllers: IControllerRegistration;
    let serverProviderRegistry: IJupyterServerProviderRegistry;
    let kernelStatusEmitter: EventEmitter<{ status: KernelMessage.Status; kernel: IKernel }>;
    let activeNotebookEditorEmitter: EventEmitter<NotebookEditor | undefined>;

    const deepnoteNotebook = makeNotebook('deepnote', 'project.deepnote');
    const jupyterNotebook = makeNotebook('jupyter-notebook', 'notebook.ipynb');

    function makeKernel(notebook: NotebookDocument, status: KernelMessage.Status): IKernel {
        const kernel = mock<IKernel>();
        when(kernel.notebook).thenReturn(notebook);
        when(kernel.status).thenReturn(status);
        when(kernel.startedAtLeastOnce).thenReturn(status !== 'unknown');
        when(kernel.kernelConnectionMetadata).thenReturn({
            kind: 'startUsingPythonInterpreter'
        } as unknown as KernelConnectionMetadata);

        const kernelInstance = instance(kernel);
        const execution = mock<INotebookKernelExecution>();
        when(execution.executionCount).thenReturn(0);
        when(kernelProvider.getKernelExecution(kernelInstance)).thenReturn(instance(execution));

        return kernelInstance;
    }

    function verifyContext(key: string, value: boolean) {
        verify(mockedVSCodeNamespaces.commands.executeCommand('setContext', key, value)).once();
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [];
        kernelStatusEmitter = new EventEmitter();
        activeNotebookEditorEmitter = new EventEmitter();

        kernelProvider = mock<IKernelProvider>();
        when(kernelProvider.onKernelStatusChanged).thenReturn(kernelStatusEmitter.event);
        when(kernelProvider.get(anything())).thenReturn(undefined);

        controllers = mock<IControllerRegistration>();
        when(controllers.onControllerSelectionChanged).thenReturn(new EventEmitter<never>().event);
        when(controllers.getSelected(anything())).thenReturn(undefined);

        serverProviderRegistry = mock<IJupyterServerProviderRegistry>();
        when(serverProviderRegistry.jupyterCollections).thenReturn([]);

        when(mockedVSCodeNamespaces.window.onDidChangeActiveTextEditor).thenReturn(new EventEmitter<never>().event);
        when(mockedVSCodeNamespaces.window.onDidChangeActiveNotebookEditor).thenReturn(
            activeNotebookEditorEmitter.event
        );
        when(mockedVSCodeNamespaces.window.activeTextEditor).thenReturn(undefined);

        service = new ActiveEditorContextService(
            undefined,
            disposables,
            instance(kernelProvider),
            instance(controllers),
            instance(serverProviderRegistry)
        );
    });

    teardown(() => {
        service.dispose();
        resetVSCodeMocks();
    });

    test('marks the kernel restartable for an active Deepnote notebook whose kernel has started', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(deepnoteNotebook));
        when(kernelProvider.get(deepnoteNotebook)).thenReturn(makeKernel(deepnoteNotebook, 'idle'));

        service.activate();

        verifyContext(EditorContexts.CanRestartNotebookKernel, true);
        verifyContext(EditorContexts.CanInterruptNotebookKernel, false);
    });

    test('marks a busy Deepnote kernel as interruptible', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(deepnoteNotebook));
        when(kernelProvider.get(deepnoteNotebook)).thenReturn(makeKernel(deepnoteNotebook, 'busy'));

        service.activate();

        verifyContext(EditorContexts.CanInterruptNotebookKernel, true);
    });

    test('keeps restart disabled for a Deepnote notebook that has no kernel yet', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(deepnoteNotebook));

        service.activate();

        verifyContext(EditorContexts.CanRestartNotebookKernel, false);
        verify(
            mockedVSCodeNamespaces.commands.executeCommand('setContext', EditorContexts.CanRestartNotebookKernel, true)
        ).never();
    });

    test('flips restart on when the active Deepnote notebook kernel reports a status change', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(deepnoteNotebook));
        service.activate();
        verifyContext(EditorContexts.CanRestartNotebookKernel, false);

        // The kernel is created on first execution, after the editor became active.
        const kernel = makeKernel(deepnoteNotebook, 'idle');
        when(kernelProvider.get(deepnoteNotebook)).thenReturn(kernel);
        kernelStatusEmitter.fire({ status: 'idle', kernel });

        verifyContext(EditorContexts.CanRestartNotebookKernel, true);
    });

    test('ignores kernel status changes from a Deepnote notebook that is not the active editor', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(jupyterNotebook));
        service.activate();

        const otherKernel = makeKernel(deepnoteNotebook, 'idle');
        when(kernelProvider.get(deepnoteNotebook)).thenReturn(otherKernel);
        kernelStatusEmitter.fire({ status: 'idle', kernel: otherKernel });

        verify(
            mockedVSCodeNamespaces.commands.executeCommand('setContext', EditorContexts.CanRestartNotebookKernel, true)
        ).never();
    });

    test('still resolves the kernel for Jupyter notebooks', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(jupyterNotebook));
        when(kernelProvider.get(jupyterNotebook)).thenReturn(makeKernel(jupyterNotebook, 'idle'));

        service.activate();

        verifyContext(EditorContexts.CanRestartNotebookKernel, true);
    });

    test('reports a Deepnote controller selection as a Jupyter kernel selection', () => {
        when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editorFor(deepnoteNotebook));
        when(controllers.getSelected(deepnoteNotebook)).thenReturn(instance(mock<IVSCodeNotebookController>()));

        service.activate();

        verifyContext(EditorContexts.IsJupyterKernelSelected, true);
    });
});
