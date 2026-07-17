import { assert } from 'chai';
import { Disposable, NotebookDocument, Uri } from 'vscode';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IDisposable } from '../../../platform/common/types';
import { IIntegrationEnvLiveRefresher } from './types';
import { IntegrationsEnvFileWatcher } from './integrationsEnvFileWatcher.node';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';

suite('IntegrationsEnvFileWatcher', () => {
    let watcher: IntegrationsEnvFileWatcher;
    let liveRefresher: IIntegrationEnvLiveRefresher;
    let disposables: IDisposable[];

    const workspaceRoot = Uri.file('/ws');

    function createMockNotebook(uri: Uri, notebookType: string = DEEPNOTE_NOTEBOOK_TYPE): NotebookDocument {
        const notebook = mock<NotebookDocument>();
        when(notebook.notebookType).thenReturn(notebookType);
        when(notebook.uri).thenReturn(uri);

        return instance(notebook);
    }

    /** The dir fsPath the watcher derives from a notebook uri (the `.deepnote` file's dir). */
    function deepnoteDirOf(uri: Uri): string {
        return Uri.joinPath(notebookPathToDeepnoteProjectFilePath(uri), '..').fsPath;
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];

        liveRefresher = mock<IIntegrationEnvLiveRefresher>();
        when(liveRefresher.refresh(anything())).thenResolve();

        watcher = new IntegrationsEnvFileWatcher(instance(liveRefresher), disposables);
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    test('refreshes every notebook view whose .deepnote dir changed (no deduplication; the refresher gates each kernel)', async () => {
        // Two open views of the SAME .deepnote file (differ only by notebook query) — both are refreshed.
        const uriA = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const uriB = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-b' });
        const notebookA = createMockNotebook(uriA);
        const notebookB = createMockNotebook(uriB);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uriA)]));

        verify(liveRefresher.refresh(anything())).once();
        const [refreshed] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [notebookA, notebookB]);
    });

    test('resolves affected notebooks via the workspace-folder root (dir-then-root fallback)', async () => {
        // The .deepnote lives in a nested dir; only the workspace ROOT changed.
        const uri = Uri.file('/ws/nested/deep/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn({
            uri: workspaceRoot
        } as never);

        // changedDirs = workspace root, NOT the .deepnote dir (/ws/nested/deep).
        await watcher.handleChangedDirs(new Set([workspaceRoot.fsPath]));

        verify(liveRefresher.refresh(anything())).once();
        const [refreshed] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [notebook]);
    });

    test('does not refresh when the changed dir matches no open Deepnote notebook', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        // An unrelated dir changed - the notebook's dir and workspace root are not in the set.
        await watcher.handleChangedDirs(new Set([Uri.file('/some/other/dir').fsPath]));

        verify(liveRefresher.refresh(anything())).never();
    });

    test('ignores non-Deepnote notebooks even when their dir changed', async () => {
        const uri = Uri.file('/ws/proj/app.ipynb').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri, 'jupyter-notebook');

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(liveRefresher.refresh(anything())).never();
    });

    test('does not refresh when the env-file feature is disabled for the notebook', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', anything())).thenReturn({
            get: () => false
        } as never);

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(liveRefresher.refresh(anything())).never();
    });

    test('refreshes when the env-file feature is explicitly enabled for the notebook', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook(uri);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', anything())).thenReturn({
            get: () => true
        } as never);

        await watcher.handleChangedDirs(new Set([deepnoteDirOf(uri)]));

        verify(liveRefresher.refresh(anything())).once();
    });
});
