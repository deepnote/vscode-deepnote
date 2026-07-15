import { assert } from 'chai';
import { CancellationToken, Disposable, NotebookDocument, Uri } from 'vscode';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';

import {
    DEEPNOTE_NOTEBOOK_TYPE,
    IDeepnoteKernelAutoSelector,
    IDeepnoteServerStarter
} from '../../../kernels/deepnote/types';
import { DataScience } from '../../../platform/common/utils/localize';
import { IDisposable } from '../../../platform/common/types';
import { IntegrationsEnvFileWatcher } from './integrationsEnvFileWatcher.node';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';

suite('IntegrationsEnvFileWatcher', () => {
    let watcher: IntegrationsEnvFileWatcher;
    let kernelAutoSelector: IDeepnoteKernelAutoSelector;
    let serverStarter: IDeepnoteServerStarter;
    let disposables: IDisposable[];

    const workspaceRoot = Uri.file('/ws');

    /** A fully-typed CancellationToken with the given cancellation state (no force cast). */
    function cancellationToken(isCancellationRequested: boolean): CancellationToken {
        const token = mock<CancellationToken>();
        when(token.isCancellationRequested).thenReturn(isCancellationRequested);

        return instance(token);
    }

    // Token handed to the restart body by window.withProgress, so tests can assert what it forwards.
    const progressToken = cancellationToken(false);

    function createMockNotebook(uri: Uri, notebookType: string = DEEPNOTE_NOTEBOOK_TYPE): NotebookDocument {
        const notebook = mock<NotebookDocument>();
        when(notebook.notebookType).thenReturn(notebookType);
        when(notebook.uri).thenReturn(uri);

        return instance(notebook);
    }

    /** The dir fsPath the watcher derives from a notebook uri (dir-then-root: the `.deepnote` file's dir). */
    function deepnoteDirOf(uri: Uri): string {
        return Uri.joinPath(notebookPathToDeepnoteProjectFilePath(uri), '..').fsPath;
    }

    function acceptRestart(): void {
        when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).thenResolve(
            DataScience.restartKernelMessageYes as unknown as undefined
        );
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];

        kernelAutoSelector = mock<IDeepnoteKernelAutoSelector>();
        serverStarter = mock<IDeepnoteServerStarter>();

        // Run the restart body inline and forward the sentinel cancellation token.
        when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) =>
            callback({ report: () => {} }, progressToken)
        );

        watcher = new IntegrationsEnvFileWatcher(instance(kernelAutoSelector), instance(serverStarter), disposables);
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('deduplicates by .deepnote file: two notebook views of one project restart the server once', async () => {
        // Two open views of the SAME .deepnote file (differ only by notebook query) share one toolkit server.
        const uriA = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const uriB = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-b' });
        const notebookA = createMockNotebook(uriA);
        const notebookB = createMockNotebook(uriB);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);
        acceptRestart();
        when(kernelAutoSelector.restartServerForNotebook(anything(), anything())).thenResolve();

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uriA)]));

        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).once();
        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).once();
        // The first view encountered represents the shared server.
        verify(kernelAutoSelector.restartServerForNotebook(notebookA, anything())).once();
        verify(kernelAutoSelector.restartServerForNotebook(notebookB, anything())).never();
    });

    test('resolves affected notebooks via the workspace-folder root (dir-then-root fallback)', async () => {
        // The .deepnote lives in a nested dir; only the workspace ROOT changed.
        const uri = Uri.file('/ws/nested/deep/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn({
            uri: workspaceRoot
        } as never);
        acceptRestart();
        when(kernelAutoSelector.restartServerForNotebook(anything(), anything())).thenResolve();

        // changedDirs = workspace root, NOT the .deepnote dir (/ws/nested/deep).
        await watcher.handleChangedDirs(new Set([workspaceRoot.fsPath]));

        verify(kernelAutoSelector.restartServerForNotebook(notebook, anything())).once();
    });

    test('shows no prompt and does not restart when no server is running', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(false);

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).never();
        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).never();
    });

    test('shows no prompt when the changed dir matches no open Deepnote notebook', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);

        // An unrelated dir changed - the notebook's dir and workspace root are not in the set.
        await watcher.handleChangedDirs(new Set([Uri.file('/some/other/dir').fsPath]));

        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).never();
        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).never();
    });

    test('ignores non-Deepnote notebooks even when their dir changed', async () => {
        const uri = Uri.file('/ws/proj/app.ipynb').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri, 'jupyter-notebook');

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).never();
        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).never();
    });

    test('accepting Restart restarts the server once, atomically (non-cancellable token)', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);
        acceptRestart();
        when(kernelAutoSelector.restartServerForNotebook(anything(), anything())).thenResolve();

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).once();

        const [nbArg, tokenArg] = capture(kernelAutoSelector.restartServerForNotebook).last();
        assert.strictEqual(nbArg, notebook, 'should restart the affected notebook');
        assert.notStrictEqual(tokenArg, progressToken, 'must not forward the cancellable withProgress token');
        assert.strictEqual(
            tokenArg.isCancellationRequested,
            false,
            'restart runs atomically, not cancellable mid-flight'
        );
    });

    test('does not restart once cancellation is requested', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);
        acceptRestart();
        when(kernelAutoSelector.restartServerForNotebook(anything(), anything())).thenResolve();

        const cancelledToken = cancellationToken(true);
        when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_options, callback) =>
            callback({ report: () => {} }, cancelledToken)
        );

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).never();
    });

    test('declining the prompt does not restart the server', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(serverStarter.isServerRunningForFile(anything())).thenReturn(true);
        // Default reset already resolves undefined; be explicit that the user dismissed the prompt.
        when(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).thenResolve(
            undefined as never
        );

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything())).once();
        verify(kernelAutoSelector.restartServerForNotebook(anything(), anything())).never();
    });
});
