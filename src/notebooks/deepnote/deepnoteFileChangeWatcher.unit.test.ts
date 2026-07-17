import type { DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { Disposable, EventEmitter, FileSystemWatcher, NotebookCellKind, NotebookDocument, Uri } from 'vscode';

import type { IControllerRegistration } from '../controllers/types';
import type { IDisposableRegistry } from '../../platform/common/types';
import type { DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteFileChangeWatcher } from './deepnoteFileChangeWatcher';
import { SnapshotService } from './snapshots/snapshotService';

const waitForTimeoutMs = 5000;
const waitForIntervalMs = 50;
const debounceWaitMs = 800;
const rapidChangeIntervalMs = 100;
const autoSaveGraceMs = 200;

/**
 * Polls until a condition is met or a timeout is reached.
 */
async function waitFor(
    condition: () => boolean,
    timeoutMs = waitForTimeoutMs,
    intervalMs = waitForIntervalMs
): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

suite('DeepnoteFileChangeWatcher', () => {
    let watcher: DeepnoteFileChangeWatcher;
    let mockDisposables: IDisposableRegistry;
    let mockNotebookManager: IDeepnoteNotebookManager;
    let onDidChangeFile: EventEmitter<Uri>;
    let onDidCreateFile: EventEmitter<Uri>;
    let readFileCalls: number;
    let applyEditCount: number;
    let saveCount: number;

    setup(() => {
        resetVSCodeMocks();
        readFileCalls = 0;
        applyEditCount = 0;
        saveCount = 0;

        mockDisposables = [];
        mockNotebookManager = instance(mock<IDeepnoteNotebookManager>());

        // Set up FileSystemWatcher mock
        onDidChangeFile = new EventEmitter<Uri>();
        onDidCreateFile = new EventEmitter<Uri>();
        const fsWatcher = mock<FileSystemWatcher>();
        when(fsWatcher.onDidChange).thenReturn(onDidChangeFile.event);
        when(fsWatcher.onDidCreate).thenReturn(onDidCreateFile.event);
        when(fsWatcher.dispose()).thenReturn();

        when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(instance(fsWatcher));

        when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
            applyEditCount++;
            return Promise.resolve(true);
        });
        when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall(() => {
            saveCount++;
            return Promise.resolve(Uri.file('/workspace/test.deepnote'));
        });

        watcher = new DeepnoteFileChangeWatcher(mockDisposables, mockNotebookManager);
        watcher.activate();
    });

    teardown(() => {
        sinon.restore();
        for (const d of mockDisposables) {
            d.dispose();
        }
        onDidChangeFile.dispose();
        onDidCreateFile.dispose();
    });

    function createMockNotebook(opts: {
        uri: Uri;
        isDirty?: boolean;
        notebookType?: string;
        cellCount?: number;
        metadata?: Record<string, unknown>;
        cells?: Array<{
            metadata?: Record<string, unknown>;
            outputs: any[];
            kind?: number;
            document?: { getText: () => string; languageId?: string };
        }>;
    }): NotebookDocument {
        const cells = (opts.cells ?? []).map((c) => ({
            ...c,
            kind: c.kind ?? NotebookCellKind.Code,
            document: {
                getText: c.document?.getText ?? (() => ''),
                languageId: c.document?.languageId ?? 'python'
            }
        }));

        return {
            uri: opts.uri,
            isDirty: opts.isDirty ?? false,
            notebookType: opts.notebookType ?? 'deepnote',
            cellCount: opts.cellCount ?? (cells.length || 1),
            metadata: opts.metadata ?? {
                deepnoteProjectId: 'e132b172-b114-410e-8331-011517db664f',
                deepnoteNotebookId: 'notebook-1'
            },
            getCells: () => cells
        } as unknown as NotebookDocument;
    }

    function setupMockFs(yamlContent: string) {
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenCall(() => {
            readFileCalls++;
            return Promise.resolve(new TextEncoder().encode(yamlContent));
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        return mockFs;
    }

    const validYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: e132b172-b114-410e-8331-011517db664f
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("hello")
`;

    test('should skip reload when content matches notebook cells', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        // Create a notebook whose cell content already matches validYaml
        const notebook = createMockNotebook({
            uri,
            cells: [
                {
                    metadata: { id: 'block-1' },
                    outputs: [],
                    kind: NotebookCellKind.Code,
                    document: { getText: () => 'print("hello")', languageId: 'python' }
                }
            ]
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        // Wait for debounce + deserialization
        await waitFor(() => readFileCalls > 0);

        // File was read, but applyEdit should NOT be called because source content matches
        assert.isAtLeast(readFileCalls, 1, 'readFile should be called');
        assert.strictEqual(applyEditCount, 0, 'applyEdit should not be called when cells match');
    });

    test('should reload on external change', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const notebook = createMockNotebook({ uri, cellCount: 0 });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        // Fire file change without a preceding save
        onDidChangeFile.fire(uri);

        // Wait for the full async chain: debounce + deserialize + applyEdit + save
        await waitFor(() => saveCount > 0);

        assert.isAtLeast(applyEditCount, 1, 'applyEdit should be called');
        assert.isAtLeast(saveCount, 1, 'save should be called after applyEdit');
    });

    test('should skip snapshot files when no SnapshotService', async () => {
        const snapshotUri = Uri.file('/workspace/snapshots/project_abc_latest.snapshot.deepnote');
        setupMockFs(validYaml);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        onDidChangeFile.fire(snapshotUri);

        // Wait well past debounce
        await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

        // Should not attempt to read the file at all
        assert.strictEqual(readFileCalls, 0, 'readFile should not be called for snapshot files');
    });

    test('should reload dirty notebooks', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const notebook = createMockNotebook({ uri, isDirty: true });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        // Wait for the full async chain to finish
        await waitFor(() => saveCount > 0);

        // Dirty notebooks should be reloaded and saved to prevent mtime conflicts
        assert.isAtLeast(readFileCalls, 1, 'readFile should be called');
        assert.isAtLeast(applyEditCount, 1, 'applyEdit should be called');
        assert.isAtLeast(saveCount, 1, 'save should be called');
    });

    test('should debounce rapid changes', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const notebook = createMockNotebook({ uri, cellCount: 0 });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        // Fire multiple changes rapidly
        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, rapidChangeIntervalMs));
        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, rapidChangeIntervalMs));
        onDidChangeFile.fire(uri);

        // Wait for debounce from the last event + processing
        await waitFor(() => applyEditCount > 0);

        // readFile should only be called once (debounced)
        assert.strictEqual(readFileCalls, 1, 'readFile should be called exactly once after debounce');
    });

    test('should handle parse errors gracefully', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const notebook = createMockNotebook({ uri, cellCount: 0 });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs('this is: [invalid: yaml: content');

        onDidChangeFile.fire(uri);

        // Wait for debounce + processing
        await waitFor(() => readFileCalls > 0);

        // Parse errors are caught and logged; applyEdit should not be called
        assert.strictEqual(applyEditCount, 0, 'applyEdit should not be called on parse error');
    });

    test('should preserve live cell outputs during reload', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const fakeOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
        const notebook = createMockNotebook({
            uri,
            cells: [
                {
                    metadata: { id: 'block-1' },
                    outputs: [fakeOutput]
                }
            ]
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        await waitFor(() => applyEditCount > 0);

        // applyEdit should be called — the output preservation runs before it
        assert.isAtLeast(applyEditCount, 1, 'applyEdit should be called');
    });

    test('should reload dirty notebooks and preserve outputs', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const fakeOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
        const notebook = createMockNotebook({
            uri,
            isDirty: true,
            cells: [
                {
                    metadata: { id: 'block-1' },
                    outputs: [fakeOutput]
                }
            ]
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        await waitFor(() => applyEditCount > 0);

        // Dirty notebook should still be reloaded with outputs preserved
        assert.isAtLeast(applyEditCount, 1, 'applyEdit should be called');
    });

    test('should not suppress real changes after auto-save', async function () {
        this.timeout(5000);
        const uri = Uri.file('/workspace/test.deepnote');

        // First change: notebook has no cells, YAML has one cell -> different -> reload
        const notebook = createMockNotebook({ uri, cellCount: 0, cells: [] });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);
        await waitFor(() => saveCount >= 1);

        // The save from the first reload set a self-write marker.
        // Simulate the auto-save fs event being consumed (as it would in real VS Code).
        onDidChangeFile.fire(uri);

        // Second real external change: use different YAML content
        const changedYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: e132b172-b114-410e-8331-011517db664f
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("world")
`;
        setupMockFs(changedYaml);
        onDidChangeFile.fire(uri);
        await waitFor(() => applyEditCount >= 2, waitForTimeoutMs);

        assert.isAtLeast(applyEditCount, 2, 'applyEdit should be called for both external changes');
    });

    test('should use atomic edit (single applyEdit for replaceCells + metadata)', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        const notebook = createMockNotebook({ uri, cellCount: 0 });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        await waitFor(() => saveCount > 0);

        // Only ONE applyEdit call (atomic: replaceCells + metadata in single WorkspaceEdit)
        assert.strictEqual(applyEditCount, 1, 'applyEdit should be called exactly once (atomic edit)');
    });

    test('should skip auto-save-triggered changes via content comparison', async () => {
        const uri = Uri.file('/workspace/test.deepnote');
        // Notebook already has the same source as validYaml but with outputs
        const fakeOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
        const notebook = createMockNotebook({
            uri,
            cells: [
                {
                    metadata: { id: 'block-1' },
                    outputs: [fakeOutput],
                    kind: NotebookCellKind.Code,
                    document: { getText: () => 'print("hello")', languageId: 'python' }
                }
            ]
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        // The main file on disk has the same source but no outputs (auto-save stripped them)
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        await waitFor(() => readFileCalls > 0);
        // Give extra time to ensure no applyEdit
        await new Promise((resolve) => setTimeout(resolve, autoSaveGraceMs));

        assert.isAtLeast(readFileCalls, 1, 'readFile should be called');
        assert.strictEqual(applyEditCount, 0, 'applyEdit should NOT be called for auto-save (same source)');
    });

    suite('normalized one-shot self-write markers', () => {
        // YAML matching `print("hello")` lives in `validYaml` above.
        const helloYaml = validYaml;
        const worldYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: e132b172-b114-410e-8331-011517db664f
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("world")
`;
        // Two-notebook file, used for the coalesced-event test.
        const twoNotebookYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: e132b172-b114-410e-8331-011517db664f
  name: Test Project
  notebooks:
    - id: n1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("one")
    - id: n2
      name: Notebook 2
      blocks:
        - id: block-2
          type: code
          sortingKey: a0
          blockGroup: '2'
          content: print("two")
`;

        test('consumes self-write keyed by base URI for a query-URI notebook (no second read)', async function () {
            this.timeout(8000);
            const baseUri = Uri.file('/x/test.deepnote');
            // Sidebar-opened notebook: URI carries a ?notebook= query.
            const notebookUri = baseUri.with({ query: 'notebook=n1' });
            // Live cells differ from the YAML on disk, so the watcher reloads + saves.
            const notebook = createMockNotebook({ uri: notebookUri, cellCount: 0, cells: [] });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            setupMockFs(helloYaml);

            // Fire the external change at the BARE base URI (fs events deliver the base URI).
            onDidChangeFile.fire(baseUri);

            // Reload runs: applyEdit, then markSelfWrite(notebook.uri) keyed by the base URI, then save.
            await waitFor(() => saveCount >= 1);
            assert.isAtLeast(applyEditCount, 1, 'reload should applyEdit on the genuine change');
            const readsAfterFirstCycle = readFileCalls;

            // The watcher's own save marked the base key. Now the fs event for that save
            // arrives at the BARE base URI — it must be consumed BEFORE any read.
            onDidChangeFile.fire(baseUri);

            // Wait well past the 500ms debounce to prove no read was scheduled.
            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(
                readFileCalls,
                readsAfterFirstCycle,
                'readFile must NOT be called again for the self-write event (consumed before the read)'
            );
        });

        test('coalesced self-writes (one base key) do not swallow a later genuine change', async function () {
            this.timeout(8000);
            const baseUri = Uri.file('/x/test.deepnote');
            // Two notebooks from the same file, different ?notebook= queries.
            // Their declared notebook ids (n1/n2) must exist in the YAML on disk so the
            // serializer can resolve them via its open-document fallback.
            const nb1 = createMockNotebook({
                uri: baseUri.with({ query: 'notebook=n1' }),
                cellCount: 0,
                cells: [],
                metadata: { deepnoteProjectId: 'e132b172-b114-410e-8331-011517db664f', deepnoteNotebookId: 'n1' }
            });
            const nb2 = createMockNotebook({
                uri: baseUri.with({ query: 'notebook=n2' }),
                cellCount: 0,
                cells: [],
                metadata: { deepnoteProjectId: 'e132b172-b114-410e-8331-011517db664f', deepnoteNotebookId: 'n2' }
            });

            // Genuine change: same two-notebook structure (so n1/n2 still resolve), but with
            // DIFFERENT block content so contentActuallyChanged is true.
            const changedTwoNotebookYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: e132b172-b114-410e-8331-011517db664f
  name: Test Project
  notebooks:
    - id: n1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("one-changed")
    - id: n2
      name: Notebook 2
      blocks:
        - id: block-2
          type: code
          sortingKey: a0
          blockGroup: '2'
          content: print("two-changed")
`;

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([nb1, nb2]);
            setupMockFs(twoNotebookYaml);

            // One external change reloads BOTH notebooks in one cycle → two markSelfWrite
            // calls, both keyed by the SAME base URI → they collapse into ONE Set entry.
            onDidChangeFile.fire(baseUri);
            await waitFor(() => saveCount >= 2);
            const applyEditsAfterCoalesce = applyEditCount;
            assert.strictEqual(applyEditsAfterCoalesce, 2, 'both notebooks reload in the coalesced cycle');

            // First bare event consumes the single one-shot marker.
            onDidChangeFile.fire(baseUri);
            await new Promise((resolve) => setTimeout(resolve, autoSaveGraceMs));

            // A genuine external change with DIFFERENT YAML must STILL reload (marker already gone).
            // A counter-based scheme would have left a stale count of 1 and wrongly swallowed this.
            setupMockFs(changedTwoNotebookYaml);
            onDidChangeFile.fire(baseUri);

            await waitFor(() => applyEditCount >= applyEditsAfterCoalesce + 1, waitForTimeoutMs);

            assert.isAtLeast(
                applyEditCount,
                applyEditsAfterCoalesce + 1,
                'genuine external change after a consumed coalesced marker must reload'
            );
        });

        test('duplicate self-write events fall through to the content comparison (no applyEdit)', async function () {
            this.timeout(8000);
            const baseUri = Uri.file('/x/test.deepnote');
            const notebookUri = baseUri.with({ query: 'notebook=n1' });
            // Live cells match helloYaml. The first external change uses worldYaml so the
            // content differs → reload + mark + save. Afterwards disk matches the live cells.
            const notebook = createMockNotebook({
                uri: notebookUri,
                cells: [
                    {
                        metadata: { id: 'block-1' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")', languageId: 'python' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            // First: genuine change (different source) → reload + markSelfWrite + save.
            setupMockFs(worldYaml);
            onDidChangeFile.fire(baseUri);
            await waitFor(() => saveCount >= 1);
            assert.strictEqual(applyEditCount, 1, 'first genuine change reloads exactly once');

            // Disk now matches the live cells (steady state after the reload).
            setupMockFs(helloYaml);
            const readsBeforeDuplicates = readFileCalls;

            // Fire TWO bare events. The first is consumed by the one-shot marker (no read);
            // the second falls through to the content comparison and ends without applyEdit.
            onDidChangeFile.fire(baseUri);
            onDidChangeFile.fire(baseUri);

            await waitFor(() => readFileCalls > readsBeforeDuplicates);
            await new Promise((resolve) => setTimeout(resolve, autoSaveGraceMs));

            assert.strictEqual(
                readFileCalls,
                readsBeforeDuplicates + 1,
                'only the second event reaches the read; the first was consumed as a self-write'
            );
            assert.strictEqual(
                applyEditCount,
                1,
                'the duplicate event ends at "Source unchanged" — no additional applyEdit'
            );
        });
    });

    suite('snapshot file watching', () => {
        let mockSnapshotService: SnapshotService;
        let snapshotWatcher: DeepnoteFileChangeWatcher;
        let snapshotDisposables: IDisposableRegistry;
        let snapshotOnDidChange: EventEmitter<Uri>;
        let snapshotOnDidCreate: EventEmitter<Uri>;
        let readSnapshotCallCount: number;
        let snapshotApplyEditCount: number;
        let snapshotSaveCount: number;
        let onFileWrittenCallback: ((uri: Uri) => void) | undefined;

        const snapshotOutputs = new Map<string, DeepnoteOutput[]>([
            [
                'block-1',
                [
                    {
                        output_type: 'execute_result',
                        data: { 'text/plain': 'Hello World' },
                        execution_count: 1
                    } as DeepnoteOutput
                ]
            ]
        ]);

        setup(() => {
            readSnapshotCallCount = 0;
            snapshotApplyEditCount = 0;
            snapshotSaveCount = 0;
            onFileWrittenCallback = undefined;
            snapshotDisposables = [];

            mockSnapshotService = mock<SnapshotService>();
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);
            when(mockSnapshotService.readSnapshot(anything(), anything())).thenCall(() => {
                readSnapshotCallCount++;
                return Promise.resolve(snapshotOutputs);
            });
            when(mockSnapshotService.onFileWritten(anything())).thenCall((cb: (uri: Uri) => void) => {
                onFileWrittenCallback = cb;
                return {
                    dispose: () => {
                        onFileWrittenCallback = undefined;
                    }
                } as Disposable;
            });

            snapshotOnDidChange = new EventEmitter<Uri>();
            snapshotOnDidCreate = new EventEmitter<Uri>();
            const fsWatcher2 = mock<FileSystemWatcher>();
            when(fsWatcher2.onDidChange).thenReturn(snapshotOnDidChange.event);
            when(fsWatcher2.onDidCreate).thenReturn(snapshotOnDidCreate.event);
            when(fsWatcher2.dispose()).thenReturn();

            when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(instance(fsWatcher2));

            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                snapshotApplyEditCount++;
                return Promise.resolve(true);
            });
            when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall(() => {
                snapshotSaveCount++;
                return Promise.resolve(Uri.file('/workspace/test.deepnote'));
            });

            snapshotWatcher = new DeepnoteFileChangeWatcher(
                snapshotDisposables,
                mockNotebookManager,
                instance(mockSnapshotService)
            );
            snapshotWatcher.activate();
        });

        teardown(() => {
            for (const d of snapshotDisposables) {
                d.dispose();
            }
            snapshotOnDidChange.dispose();
            snapshotOnDidCreate.dispose();
        });

        test('should update outputs when snapshot file changes', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount > 0);

            assert.isAtLeast(readSnapshotCallCount, 1, 'readSnapshot should be called');
            assert.isAtLeast(snapshotApplyEditCount, 1, 'applyEdit should be called');
        });

        test('should skip when SnapshotService is not injected', async () => {
            // Create a watcher without SnapshotService
            const noSnapshotDisposables: IDisposableRegistry = [];
            const noSnapshotWatcher = new DeepnoteFileChangeWatcher(noSnapshotDisposables, mockNotebookManager);
            noSnapshotWatcher.activate();

            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called');
            assert.strictEqual(snapshotApplyEditCount, 0, 'applyEdit should not be called');

            for (const d of noSnapshotDisposables) {
                d.dispose();
            }
        });

        test('should skip self-triggered snapshot writes via onFileWritten', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [{ metadata: { id: 'block-1', type: 'code' }, outputs: [] }]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            // Simulate SnapshotService writing the file → triggers onFileWritten callback
            assert.isDefined(onFileWrittenCallback, 'onFileWritten callback should be registered');
            onFileWrittenCallback!(snapshotUri);

            // Now fire the filesystem event — should be consumed as self-write
            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called for self-writes');
        });

        test('should skip when snapshots are disabled', async () => {
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(false);

            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );

            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called when disabled');
        });

        test('should debounce rapid snapshot changes for same project', async () => {
            const snapshotUri1 = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_2025-01-15T10-31-48.snapshot.deepnote'
            );
            const snapshotUri2 = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri1);
            await new Promise((resolve) => setTimeout(resolve, rapidChangeIntervalMs));
            snapshotOnDidChange.fire(snapshotUri2);

            await waitFor(() => snapshotApplyEditCount > 0);

            assert.strictEqual(readSnapshotCallCount, 1, 'readSnapshot should be called exactly once');
        });

        test('should handle onDidCreate for new snapshot files', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidCreate.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount > 0);

            assert.isAtLeast(readSnapshotCallCount, 1, 'readSnapshot should be called for onDidCreate');
            assert.isAtLeast(snapshotApplyEditCount, 1, 'applyEdit should be called for onDidCreate');
        });

        test('should skip update when snapshot outputs match live state', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            // First snapshot change — should apply (replaceCells + metadata restore = 2 applyEdit calls)
            snapshotOnDidChange.fire(snapshotUri);
            await waitFor(() => snapshotApplyEditCount >= 2);
            assert.strictEqual(snapshotApplyEditCount, 2, 'applyEdit should be called on first snapshot change');

            // Now simulate that the notebook's live outputs match the snapshot
            // (outputs were successfully applied). Recreate notebook with matching outputs.
            const outputItem = {
                mime: 'text/plain',
                data: new TextEncoder().encode('Hello World')
            };
            const notebookWithOutputs = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [{ items: [outputItem], metadata: { executionCount: 1 } }],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebookWithOutputs]);

            // Second identical snapshot change — should be skipped (live state matches)
            snapshotOnDidChange.fire(snapshotUri);
            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));
            assert.strictEqual(snapshotApplyEditCount, 2, 'applyEdit should NOT be called again for matching outputs');
        });

        test('should update outputs when content changed but count is the same', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const existingOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [existingOutput],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount > 0);

            assert.isAtLeast(readSnapshotCallCount, 1, 'readSnapshot should be called');
            assert.isAtLeast(snapshotApplyEditCount, 1, 'applyEdit should be called even when output count matches');
        });

        test('should skip main-file reload after snapshot update via self-write tracking', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebookUri = Uri.file('/workspace/test.deepnote');
            const notebook = createMockNotebook({
                uri: notebookUri,
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")', languageId: 'python' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            // Set up mock fs for the main-file reload path
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenCall(() => {
                return Promise.resolve(new TextEncoder().encode(validYaml));
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            // First: fire snapshot change → outputs applied (replaceCells + metadata restore = 2 applyEdit calls)
            snapshotOnDidChange.fire(snapshotUri);
            await waitFor(() => snapshotApplyEditCount >= 2);
            assert.strictEqual(snapshotApplyEditCount, 2, 'applyEdit should be called for snapshot');

            // The snapshot update marked the main file URI as self-write.
            // Fire a main-file change — content comparison (same source) should skip it
            // even without the self-write (double protection).
            snapshotOnDidChange.fire(notebookUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            // applyEdit should NOT be called again
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should NOT be called again for recently snapshot-updated notebook'
            );
        });

        test('should use two-phase edit for snapshot updates (replaceCells + metadata restore)', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount >= 2);

            // Two applyEdit calls: replaceCells then metadata restore (separate to avoid VS Code ID clobbering)
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should be called exactly twice (replaceCells + metadata restore)'
            );
        });

        test('should call workspace.save after snapshot fallback output update', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount > 0);
            await waitFor(() => snapshotSaveCount > 0);

            assert.strictEqual(snapshotSaveCount, 1, 'workspace.save should be called after snapshot fallback update');
        });

        test('should preserve outputs for cells not covered by snapshot', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const existingOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    },
                    {
                        metadata: { id: 'block-2', type: 'code' },
                        outputs: [existingOutput],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("world")' }
                    }
                ]
            });

            // Snapshot only has outputs for block-1, not block-2
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount >= 2);

            // Only block-1 should be updated; block-2 is untouched (per-cell updates)
            // Two applyEdit calls: replaceCells + metadata restore
            assert.strictEqual(snapshotApplyEditCount, 2, 'applyEdit should be called twice (replaceCells + metadata)');
        });

        test('should apply snapshot outputs using original blocks when metadata is lost', async () => {
            // Create a mock notebook manager that returns an original project via the exact
            // (projectId, notebookId) lookup the snapshot path uses.
            const mockedManager = mock<IDeepnoteNotebookManager>();
            when(mockedManager.getProjectForNotebook('e132b172-b114-410e-8331-011517db664f', 'notebook-1')).thenReturn({
                version: '1.0',
                metadata: { createdAt: '2025-01-01T00:00:00Z' },
                project: {
                    id: 'e132b172-b114-410e-8331-011517db664f',
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Notebook 1',
                            blocks: [{ id: 'block-1', type: 'code', sortingKey: 'a0' }]
                        }
                    ]
                }
            } as DeepnoteFile);

            // Re-create the watcher with the mocked manager
            const fallbackDisposables: IDisposableRegistry = [];
            const fallbackOnDidChange = new EventEmitter<Uri>();
            const fallbackOnDidCreate = new EventEmitter<Uri>();
            const fsWatcher3 = mock<FileSystemWatcher>();
            when(fsWatcher3.onDidChange).thenReturn(fallbackOnDidChange.event);
            when(fsWatcher3.onDidCreate).thenReturn(fallbackOnDidCreate.event);
            when(fsWatcher3.dispose()).thenReturn();

            when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(instance(fsWatcher3));

            let fallbackApplyEditCount = 0;
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                fallbackApplyEditCount++;
                return Promise.resolve(true);
            });

            const fallbackWatcher = new DeepnoteFileChangeWatcher(
                fallbackDisposables,
                instance(mockedManager),
                instance(mockSnapshotService)
            );
            fallbackWatcher.activate();

            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            // Cell has NO id in metadata — simulates VS Code losing metadata after replaceCells
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                metadata: {
                    deepnoteProjectId: 'e132b172-b114-410e-8331-011517db664f',
                    deepnoteNotebookId: 'notebook-1'
                },
                cells: [
                    {
                        metadata: { type: 'code' }, // No id!
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            // Use new snapshot outputs
            const newOutputs = new Map<string, DeepnoteOutput[]>([
                [
                    'block-1',
                    [
                        {
                            output_type: 'execute_result',
                            data: { 'text/plain': 'Fallback Output' },
                            execution_count: 2
                        } as DeepnoteOutput
                    ]
                ]
            ]);
            when(mockSnapshotService.readSnapshot(anything(), anything())).thenReturn(Promise.resolve(newOutputs));

            fallbackOnDidChange.fire(snapshotUri);

            await waitFor(() => fallbackApplyEditCount > 0);

            assert.isAtLeast(fallbackApplyEditCount, 1, 'applyEdit should be called even without metadata block IDs');

            // Cleanup
            for (const d of fallbackDisposables) {
                d.dispose();
            }
            fallbackOnDidChange.dispose();
            fallbackOnDidCreate.dispose();
        });

        test('should only update cells whose outputs changed (per-cell updates)', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );

            // Two cells: block-1 has no outputs (will get updated), block-2 already has matching outputs
            const outputItem = {
                mime: 'text/plain',
                data: new TextEncoder().encode('Existing output')
            };
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    },
                    {
                        metadata: { id: 'block-2', type: 'code' },
                        outputs: [{ items: [outputItem] }],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("world")' }
                    }
                ]
            });

            // Snapshot has outputs for both blocks, but block-2's output matches live state
            const multiOutputs = new Map<string, DeepnoteOutput[]>([
                [
                    'block-1',
                    [
                        {
                            output_type: 'execute_result',
                            data: { 'text/plain': 'Hello World' },
                            execution_count: 1
                        } as DeepnoteOutput
                    ]
                ],
                [
                    'block-2',
                    [
                        {
                            output_type: 'execute_result',
                            data: { 'text/plain': 'Existing output' },
                            execution_count: 1
                        } as DeepnoteOutput
                    ]
                ]
            ]);
            when(mockSnapshotService.readSnapshot(anything(), anything())).thenCall(() => {
                readSnapshotCallCount++;
                return Promise.resolve(multiOutputs);
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount >= 2);

            // Two applyEdit calls (replaceCells + metadata restore), containing edits only for changed cells
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should be called exactly twice (replaceCells + metadata)'
            );
        });

        test('should apply outputs via execution API when kernel is active', async () => {
            const execDisposables: IDisposableRegistry = [];
            const execOnDidChange = new EventEmitter<Uri>();
            const execOnDidCreate = new EventEmitter<Uri>();
            const fsWatcherExec = mock<FileSystemWatcher>();
            when(fsWatcherExec.onDidChange).thenReturn(execOnDidChange.event);
            when(fsWatcherExec.onDidCreate).thenReturn(execOnDidCreate.event);
            when(fsWatcherExec.dispose()).thenReturn();
            when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(
                instance(fsWatcherExec)
            );

            let execApplyEditCount = 0;
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                execApplyEditCount++;
                return Promise.resolve(true);
            });

            // Mock controller registration with selected controller
            let executionCreateCount = 0;
            let executionStartCount = 0;
            let executionReplaceOutputCount = 0;
            let executionEndCount = 0;

            const mockVSCodeController = {
                createNotebookCellExecution: () => {
                    executionCreateCount++;
                    return {
                        start: () => {
                            executionStartCount++;
                        },
                        replaceOutput: () => {
                            executionReplaceOutputCount++;
                            return Promise.resolve();
                        },
                        end: () => {
                            executionEndCount++;
                        }
                    };
                }
            };
            const mockSelectedController = { controller: mockVSCodeController };
            const mockedControllerRegistration = mock<IControllerRegistration>();
            when(mockedControllerRegistration.getSelected(anything())).thenReturn(mockSelectedController as any);

            const execWatcher = new DeepnoteFileChangeWatcher(
                execDisposables,
                mockNotebookManager,
                instance(mockSnapshotService),
                instance(mockedControllerRegistration)
            );
            execWatcher.activate();

            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            execOnDidChange.fire(snapshotUri);

            await waitFor(() => executionCreateCount > 0);

            assert.strictEqual(executionCreateCount, 1, 'createNotebookCellExecution should be called once');
            assert.strictEqual(executionStartCount, 1, 'execution.start should be called once');
            assert.strictEqual(executionReplaceOutputCount, 1, 'execution.replaceOutput should be called once');
            assert.strictEqual(executionEndCount, 1, 'execution.end should be called once');
            assert.strictEqual(execApplyEditCount, 0, 'applyEdit should NOT be called when using execution API');

            for (const d of execDisposables) {
                d.dispose();
            }
            execOnDidChange.dispose();
            execOnDidCreate.dispose();
        });

        test('should not apply updates when cells have no block IDs and no fallback', async () => {
            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: {},
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => readSnapshotCallCount >= 1);

            assert.isAtLeast(readSnapshotCallCount, 1, 'readSnapshot should be called');
            assert.strictEqual(
                snapshotApplyEditCount,
                0,
                'applyEdit should NOT be called when no block IDs can be resolved'
            );
        });

        test('should fall back to replaceCells when no kernel is active', async () => {
            const fbDisposables: IDisposableRegistry = [];
            const fbOnDidChange = new EventEmitter<Uri>();
            const fbOnDidCreate = new EventEmitter<Uri>();
            const fsWatcherFb = mock<FileSystemWatcher>();
            when(fsWatcherFb.onDidChange).thenReturn(fbOnDidChange.event);
            when(fsWatcherFb.onDidCreate).thenReturn(fbOnDidCreate.event);
            when(fsWatcherFb.dispose()).thenReturn();
            when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(
                instance(fsWatcherFb)
            );

            let fbApplyEditCount = 0;
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                fbApplyEditCount++;
                return Promise.resolve(true);
            });

            const mockedControllerRegistration = mock<IControllerRegistration>();
            when(mockedControllerRegistration.getSelected(anything())).thenReturn(undefined);

            const fbWatcher = new DeepnoteFileChangeWatcher(
                fbDisposables,
                mockNotebookManager,
                instance(mockSnapshotService),
                instance(mockedControllerRegistration)
            );
            fbWatcher.activate();

            const snapshotUri = Uri.file(
                '/workspace/snapshots/my-project_e132b172-b114-410e-8331-011517db664f_latest.snapshot.deepnote'
            );
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [
                    {
                        metadata: { id: 'block-1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("hello")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            fbOnDidChange.fire(snapshotUri);

            await waitFor(() => fbApplyEditCount > 0);

            assert.isAtLeast(fbApplyEditCount, 1, 'applyEdit should be called when no kernel is active (fallback)');

            for (const d of fbDisposables) {
                d.dispose();
            }
            fbOnDidChange.dispose();
            fbOnDidCreate.dispose();
        });
    });
});
