import { assert } from 'chai';
import {
    ConfigurationChangeEvent,
    Disposable,
    EventEmitter,
    FileSystemWatcher,
    NotebookDocument,
    RelativePattern,
    Uri,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent
} from 'vscode';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import * as sinon from 'sinon';
import { DEFAULT_ENV_FILE, DEFAULT_INTEGRATIONS_FILE } from '@deepnote/database-integrations';

import { IDisposable } from '../../../platform/common/types';
import { IFileSystem } from '../../../platform/common/platform/types';
import { IIntegrationEnvLiveRefresher } from './types';
import { INTEGRATIONS_ENV_FILE_SETTING } from '../../../platform/notebooks/deepnote/integrationsEnvFileSettings';
import { createMockNotebook } from '../deepnoteTestHelpers';
import { debounceTimeInMilliseconds, IntegrationsEnvFileWatcher } from './integrationsEnvFileWatcher.node';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';

suite('IntegrationsEnvFileWatcher', () => {
    let watcher: IntegrationsEnvFileWatcher;
    let liveRefresher: IIntegrationEnvLiveRefresher;
    let fileSystem: IFileSystem;
    let disposables: IDisposable[];
    let clock: sinon.SinonFakeTimers;
    /** One emitter per file system watcher the code under test asked VS Code to create, keyed by dir + file name. */
    let fileEvents: Map<string, EventEmitter<Uri>>;
    let onDidOpenNotebookDocument: EventEmitter<NotebookDocument>;
    let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;

    const workspaceFolder: WorkspaceFolder = { index: 0, name: 'ws', uri: Uri.file('/ws') };

    function createFileSystemWatcher(pattern: RelativePattern): FileSystemWatcher {
        const emitter = new EventEmitter<Uri>();
        fileEvents.set(watcherKey(pattern.baseUri, pattern.pattern), emitter);
        disposables.push(emitter);

        const fsWatcher = mock<FileSystemWatcher>();
        when(fsWatcher.onDidChange).thenReturn(emitter.event);
        when(fsWatcher.onDidCreate).thenReturn(emitter.event);
        when(fsWatcher.onDidDelete).thenReturn(emitter.event);
        when(fsWatcher.dispose()).thenReturn();

        return instance(fsWatcher);
    }

    /** The dir the watcher derives from a notebook uri (the `.deepnote` file's dir). */
    function deepnoteDirOf(uri: Uri): Uri {
        return Uri.joinPath(notebookPathToDeepnoteProjectFilePath(uri), '..');
    }

    /** Fires a watcher event and lets the debounce elapse, as a real edit of the file would. */
    async function fireEnvFileChange(dir: Uri, fileName: string = DEFAULT_INTEGRATIONS_FILE): Promise<void> {
        fireEnvFileEvent(dir, fileName);

        await clock.tickAsync(debounceTimeInMilliseconds);
    }

    /** Fires a watcher event without advancing the clock, so callers can queue a burst within one debounce window. */
    function fireEnvFileEvent(dir: Uri, fileName: string): void {
        const emitter = fileEvents.get(watcherKey(dir, fileName));
        if (!emitter) {
            assert.fail(`No file system watcher was created for ${fileName} in ${dir.fsPath}`);
        }

        emitter.fire(Uri.joinPath(dir, fileName));
    }

    function watcherKey(dir: Uri, fileName: string): string {
        return `${dir.fsPath}::${fileName}`;
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        fileEvents = new Map<string, EventEmitter<Uri>>();
        when(
            mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything(), anything(), anything(), anything())
        ).thenCall(createFileSystemWatcher);

        onDidOpenNotebookDocument = new EventEmitter<NotebookDocument>();
        disposables.push(onDidOpenNotebookDocument);
        when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(onDidOpenNotebookDocument.event);
        when(mockedVSCodeNamespaces.workspace.onDidChangeWorkspaceFolders).thenReturn(
            new EventEmitter<WorkspaceFoldersChangeEvent>().event
        );
        onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
        disposables.push(onDidChangeConfiguration);
        when(mockedVSCodeNamespaces.workspace.onDidChangeConfiguration).thenReturn(onDidChangeConfiguration.event);
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

        // The shared mock's `get()` ignores the default argument; the real API returns it when the setting is
        // unset, which is what the `envFile.enabled` gate relies on. Individual tests override this.
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', anything())).thenReturn({
            get: (_section: string, defaultValue?: unknown) => defaultValue
        } as never);

        liveRefresher = mock<IIntegrationEnvLiveRefresher>();
        when(liveRefresher.refresh(anything(), anything())).thenResolve();

        // Default: a `.deepnote.env.yaml` exists, so a dir change refreshes; individual tests override this.
        fileSystem = mock<IFileSystem>();
        when(fileSystem.exists(anything())).thenResolve(true);

        watcher = new IntegrationsEnvFileWatcher(instance(liveRefresher), instance(fileSystem), disposables);
    });

    teardown(() => {
        clock.restore();
        disposables = dispose(disposables);
    });

    test('refreshes every notebook view whose .deepnote dir changed (no deduplication; the refresher gates each kernel)', async () => {
        // Two open views of the SAME .deepnote file (differ only by notebook query) — both are refreshed.
        const uriA = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const uriB = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-b' });
        const notebookA = createMockNotebook({ uri: uriA });
        const notebookB = createMockNotebook({ uri: uriB });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookA, notebookB]);
        watcher.activate();

        await fireEnvFileChange(deepnoteDirOf(uriA));

        verify(liveRefresher.refresh(anything(), anything())).once();
        const [refreshed, trigger] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [notebookA, notebookB]);
        assert.strictEqual(trigger, 'env_file', 'a watched file change is not a SecretStorage change');
    });

    test('resolves affected notebooks via the workspace-folder root (dir-then-root fallback)', async () => {
        // The .deepnote lives in a nested dir; only the workspace ROOT changed.
        const uri = Uri.file('/ws/nested/deep/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn(workspaceFolder);
        watcher.activate();

        await fireEnvFileChange(workspaceFolder.uri);

        verify(liveRefresher.refresh(anything(), anything())).once();
        const [refreshed] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [notebook]);
    });

    test('coalesces a burst of env file events into a single refresh', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        watcher.activate();

        // Both watched files saved at once — the debounce must collapse them into one refresh.
        fireEnvFileEvent(deepnoteDirOf(uri), DEFAULT_INTEGRATIONS_FILE);
        fireEnvFileEvent(deepnoteDirOf(uri), DEFAULT_ENV_FILE);
        await clock.tickAsync(debounceTimeInMilliseconds);

        verify(liveRefresher.refresh(anything(), anything())).once();
    });

    test('watches the dir of a notebook opened after activation', async () => {
        // Outside the workspace folder, so the dir is watched only because the notebook was opened.
        const uri = Uri.file('/elsewhere/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        watcher.activate();

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        onDidOpenNotebookDocument.fire(notebook);

        await fireEnvFileChange(deepnoteDirOf(uri));

        verify(liveRefresher.refresh(anything(), anything())).once();
    });

    test('does not refresh when the changed dir matches no open Deepnote notebook', async () => {
        const otherFolder: WorkspaceFolder = { index: 1, name: 'other', uri: Uri.file('/other') };
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder, otherFolder]);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        watcher.activate();

        // An unrelated workspace folder changed — the notebook's dir and its workspace root are untouched.
        await fireEnvFileChange(otherFolder.uri);

        verify(liveRefresher.refresh(anything(), anything())).never();
    });

    test('ignores non-Deepnote notebooks even when their dir changed', async () => {
        const uri = Uri.file('/ws/app.ipynb').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri, notebookType: 'jupyter-notebook' });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        watcher.activate();

        // The dir is watched as a workspace folder, so the event lands — the notebook type must rule it out.
        await fireEnvFileChange(deepnoteDirOf(uri));

        verify(liveRefresher.refresh(anything(), anything())).never();
    });

    test('does not refresh when the env-file feature is disabled for the notebook', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', anything())).thenReturn({
            get: () => false
        } as never);
        watcher.activate();

        await fireEnvFileChange(deepnoteDirOf(uri));

        verify(liveRefresher.refresh(anything(), anything())).never();
    });

    test('refreshes when the last .deepnote.env.yaml is deleted, so its SQL_* vars are dropped', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        // The file is gone by the time the debounce fires — the same state as the unrelated-.env test below.
        when(fileSystem.exists(anything())).thenResolve(false);
        watcher.activate();

        await fireEnvFileChange(deepnoteDirOf(uri), DEFAULT_INTEGRATIONS_FILE);

        // The refresh IS the clearing mechanism: set_integration_env() clears what it previously set.
        verify(liveRefresher.refresh(anything(), anything())).once();
    });

    test('refreshes every open Deepnote notebook when the envFile setting is toggled', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });
        const otherNotebook = createMockNotebook({
            uri: Uri.file('/ws/other.ipynb'),
            notebookType: 'jupyter-notebook'
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook, otherNotebook]);
        // Disabled — the per-notebook gate would filter this notebook out, yet its kernel still holds file credentials.
        when(mockedVSCodeNamespaces.workspace.getConfiguration('deepnote', anything())).thenReturn({
            get: () => false
        } as never);
        watcher.activate();

        onDidChangeConfiguration.fire({
            affectsConfiguration: (section: string) => section === INTEGRATIONS_ENV_FILE_SETTING
        });
        await clock.tickAsync(0);

        verify(liveRefresher.refresh(anything(), anything())).once();
        const [refreshed] = capture(liveRefresher.refresh).last();
        assert.deepStrictEqual([...refreshed], [notebook], 'only Deepnote notebooks are refreshed');
    });

    test('ignores configuration changes that do not touch the envFile setting', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        watcher.activate();

        onDidChangeConfiguration.fire({ affectsConfiguration: () => false });
        await clock.tickAsync(0);

        verify(liveRefresher.refresh(anything(), anything())).never();
    });

    test('does not refresh when no .deepnote.env.yaml exists for the notebook (an unrelated .env change)', async () => {
        const uri = Uri.file('/ws/proj/app.deepnote').with({ query: 'notebook=nb-a' });
        const notebook = createMockNotebook({ uri });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        // No integrations file present in any candidate dir — the change must be treated as unrelated.
        when(fileSystem.exists(anything())).thenResolve(false);
        watcher.activate();

        await fireEnvFileChange(deepnoteDirOf(uri), DEFAULT_ENV_FILE);

        verify(liveRefresher.refresh(anything(), anything())).never();
    });
});
