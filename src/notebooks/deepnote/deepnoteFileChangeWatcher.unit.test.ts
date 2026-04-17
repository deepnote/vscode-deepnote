import { DeepnoteFile, serializeDeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { anything, instance, mock, reset, resetCalls, when } from 'ts-mockito';
import {
    Disposable,
    EventEmitter,
    FileSystemWatcher,
    NotebookCellData,
    NotebookCellKind,
    NotebookDocument,
    NotebookEdit,
    Uri
} from 'vscode';
import { join } from '../../platform/vscode-path/path';
import { logger } from '../../platform/logging';

import type { IDisposableRegistry } from '../../platform/common/types';
import type { DeepnoteOutput, DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import type { IControllerRegistration } from '../controllers/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { DeepnoteFileChangeWatcher } from './deepnoteFileChangeWatcher';
import { SnapshotService } from './snapshots/snapshotService';

const validProject: DeepnoteFile = {
    version: '1.0.0',
    metadata: { createdAt: '2025-01-01T00:00:00Z' },
    project: {
        id: 'project-1',
        name: 'Test Project',
        notebooks: [
            {
                id: 'notebook-1',
                name: 'Notebook 1',
                blocks: [
                    {
                        id: 'block-1',
                        type: 'code',
                        sortingKey: 'a0',
                        blockGroup: '1',
                        content: 'print("hello")',
                        metadata: {}
                    }
                ]
            }
        ]
    }
};

const multiNotebookProject: DeepnoteFile = {
    version: '1.0.0',
    metadata: { createdAt: '2025-01-01T00:00:00Z' },
    project: {
        id: 'project-1',
        name: 'Multi Notebook Project',
        notebooks: [
            {
                id: 'notebook-1',
                name: 'Notebook 1',
                blocks: [
                    {
                        id: 'block-nb1',
                        type: 'code',
                        sortingKey: 'a0',
                        blockGroup: '1',
                        content: 'print("nb1-new")',
                        metadata: {}
                    }
                ]
            },
            {
                id: 'notebook-2',
                name: 'Notebook 2',
                blocks: [
                    {
                        id: 'block-nb2',
                        type: 'code',
                        sortingKey: 'a0',
                        blockGroup: '1',
                        content: 'print("nb2-new")',
                        metadata: {}
                    }
                ]
            }
        ]
    }
};

const multiNotebookYaml = serializeDeepnoteFile(multiNotebookProject);

const waitForTimeoutMs = 5000;
const waitForIntervalMs = 50;
const debounceWaitMs = 800;
const rapidChangeIntervalMs = 100;
const autoSaveGraceMs = 200;
const postSnapshotReadGraceMs = 100;

interface NotebookEditCapture {
    uriKey: string;
    cellSourceJoined: string;
}

interface SnapshotInteractionCapture {
    cellSourcesJoined: string;
    outputPlainJoined: string;
    uriKey: string;
}

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
    let testFixturesDir: string;

    suiteSetup(() => {
        testFixturesDir = mkdtempSync(join(tmpdir(), 'deepnote-fcw-'));
    });

    suiteTeardown(() => {
        rmSync(testFixturesDir, { recursive: true, force: true });
    });

    function testFileUri(...pathSegments: string[]): Uri {
        return Uri.joinPath(Uri.file(testFixturesDir), ...pathSegments);
    }

    let watcher: DeepnoteFileChangeWatcher;
    let mockDisposables: IDisposableRegistry;
    let mockedNotebookManager: IDeepnoteNotebookManager;
    let mockNotebookManager: IDeepnoteNotebookManager;
    let onDidChangeFile: EventEmitter<Uri>;
    let onDidCreateFile: EventEmitter<Uri>;
    let onDidSaveNotebook: EventEmitter<NotebookDocument>;
    let readFileCalls: number;
    let applyEditCount: number;
    let saveCount: number;

    setup(() => {
        resetVSCodeMocks();
        readFileCalls = 0;
        applyEditCount = 0;
        saveCount = 0;

        mockDisposables = [];

        mockedNotebookManager = mock<IDeepnoteNotebookManager>();
        when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(validProject);
        when(mockedNotebookManager.updateOriginalProject(anything(), anything(), anything())).thenReturn();
        mockNotebookManager = instance(mockedNotebookManager);

        // Set up FileSystemWatcher mock
        onDidChangeFile = new EventEmitter<Uri>();
        onDidCreateFile = new EventEmitter<Uri>();
        const fsWatcher = mock<FileSystemWatcher>();
        when(fsWatcher.onDidChange).thenReturn(onDidChangeFile.event);
        when(fsWatcher.onDidCreate).thenReturn(onDidCreateFile.event);
        when(fsWatcher.dispose()).thenReturn();

        when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(instance(fsWatcher));

        onDidSaveNotebook = new EventEmitter<NotebookDocument>();
        when(mockedVSCodeNamespaces.workspace.onDidSaveNotebookDocument).thenReturn(onDidSaveNotebook.event);

        when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
            applyEditCount++;
            return Promise.resolve(true);
        });
        when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall((uri: Uri) => {
            saveCount++;
            return Promise.resolve(uri);
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
        onDidSaveNotebook.dispose();
    });

    function createMockNotebook(opts: {
        uri: Uri;
        isDirty?: boolean;
        notebookType?: string;
        cellCount?: number;
        metadata?: Record<string, unknown>;
        cells?: Array<
            | {
                  metadata?: Record<string, unknown>;
                  outputs: any[];
                  kind?: number;
                  document?: { getText: () => string; languageId?: string };
              }
            | NotebookCellData
        >;
    }): NotebookDocument {
        const cells = (opts.cells ?? []).map((c) => ({
            ...c,
            kind: c.kind ?? NotebookCellKind.Code,
            document:
                'document' in c && c.document
                    ? { getText: c.document.getText ?? (() => ''), languageId: c.document.languageId ?? 'python' }
                    : {
                          getText: () => ('value' in c ? (c.value as string) : ''),
                          languageId: 'languageId' in c ? (c.languageId as string) : 'python'
                      }
        }));

        return {
            uri: opts.uri,
            isDirty: opts.isDirty ?? false,
            notebookType: opts.notebookType ?? 'deepnote',
            cellCount: opts.cellCount ?? (cells.length || 1),
            metadata: opts.metadata ?? {
                deepnoteProjectId: 'project-1',
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
        when(mockFs.writeFile(anything(), anything())).thenReturn(Promise.resolve());
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        return mockFs;
    }

    const validYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: project-1
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

    suite('save-triggered self-write detection', () => {
        test('saving a deepnote notebook should suppress the next FS change event', async () => {
            const uri = testFileUri('self-write.deepnote');
            const notebook = createMockNotebook({
                notebookType: 'deepnote',
                uri
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            setupMockFs(validYaml);

            onDidSaveNotebook.fire(notebook);
            onDidChangeFile.fire(uri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(applyEditCount, 0, 'FS change after deepnote save should be treated as self-write');
        });

        test('saving a non-deepnote notebook should not suppress FS change events', async function () {
            this.timeout(8000);
            const fileUri = testFileUri('jupyter-save.deepnote');
            const jupyterNotebook = createMockNotebook({
                cellCount: 0,
                notebookType: 'jupyter-notebook',
                uri: fileUri
            });
            const deepnoteNotebook = createMockNotebook({
                cellCount: 0,
                uri: fileUri.with({ query: 'view=1' })
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([jupyterNotebook, deepnoteNotebook]);
            setupMockFs(validYaml);

            onDidSaveNotebook.fire(jupyterNotebook);
            onDidChangeFile.fire(fileUri);

            await waitFor(() => applyEditCount >= 1);

            assert.isAtLeast(applyEditCount, 1);
        });

        test('self-write is consumed exactly once', async function () {
            this.timeout(8000);
            const uri = testFileUri('self-write-once.deepnote');
            const notebook = createMockNotebook({
                notebookType: 'deepnote',
                uri,
                cellCount: 0
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            setupMockFs(validYaml);

            onDidSaveNotebook.fire(notebook);
            onDidChangeFile.fire(uri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(applyEditCount, 0, 'first FS event after save should be skipped');

            onDidChangeFile.fire(uri);

            await waitFor(() => applyEditCount >= 1);

            assert.isAtLeast(applyEditCount, 1);
        });
    });

    test('should skip reload when content matches notebook cells', async () => {
        const uri = testFileUri('test.deepnote');
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
        const uri = testFileUri('test.deepnote');
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
        const snapshotUri = testFileUri('snapshots', 'project_abc_latest.snapshot.deepnote');
        setupMockFs(validYaml);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        onDidChangeFile.fire(snapshotUri);

        // Wait well past debounce
        await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

        // Should not attempt to read the file at all
        assert.strictEqual(readFileCalls, 0, 'readFile should not be called for snapshot files');
    });

    test('should reload dirty notebooks', async () => {
        const uri = testFileUri('test.deepnote');
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
        const uri = testFileUri('test.deepnote');
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
        const uri = testFileUri('test.deepnote');
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
        const uri = testFileUri('test.deepnote');
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
        const uri = testFileUri('test.deepnote');
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
        this.timeout(10_000);
        const uri = testFileUri('test.deepnote');

        // First change: notebook has no cells, YAML has one cell -> different -> reload
        const notebook = createMockNotebook({ uri, cellCount: 0, cells: [] });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        // Override save mock to fire onDidSaveNotebook (matching real VS Code behavior).
        // The onDidSaveNotebookDocument handler calls markSelfWrite, producing the
        // second self-write marker that corresponds to the serializer's save-triggered write.
        when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall((saveUri: Uri) => {
            saveCount++;
            onDidSaveNotebook.fire(notebook);
            return Promise.resolve(saveUri);
        });

        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);
        await waitFor(() => saveCount >= 1);

        // The first reload sets 2 self-write markers (writeFile + save).
        // Consume them both with simulated fs events.
        onDidChangeFile.fire(uri);
        onDidChangeFile.fire(uri);

        // Second real external change: use different YAML content
        const changedYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: project-1
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

    test('editor→external→editor→external: second external edit must reload (self-write leak regression)', async function () {
        this.timeout(15_000);
        const uri = testFileUri('self-write-leak.deepnote');

        when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(multiNotebookProject);

        // Initial state: editor content matches disk — use the real converter
        const converter = new DeepnoteDataConverter();
        const nb1 = multiNotebookProject.project.notebooks[0];
        const notebook = createMockNotebook({
            uri,
            metadata: { deepnoteProjectId: multiNotebookProject.project.id, deepnoteNotebookId: nb1.id },
            cells: converter.convertBlocksToCells(nb1.blocks)
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(multiNotebookYaml);

        // Real VS Code behavior: workspace.save() fires onDidSaveNotebookDocument.
        // executeMainFileSync calls markSelfWrite before workspace.save, AND the
        // onDidSaveNotebookDocument handler also calls markSelfWrite — two marks
        // for one FS event. This leaks a phantom self-write count.
        when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall((saveUri: Uri) => {
            saveCount++;
            onDidSaveNotebook.fire(notebook);
            return Promise.resolve(saveUri);
        });

        // Step 1: editor edit → user saves notebook 1
        onDidSaveNotebook.fire(notebook);
        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));
        assert.strictEqual(applyEditCount, 0, 'Step 1: editor save FS event should be suppressed');

        // Step 2: first external edit → triggers executeMainFileSync (reload works)
        const externalProject1 = structuredClone(multiNotebookProject);
        externalProject1.project.notebooks[0].blocks![0].content = 'print("external-1")';
        setupMockFs(serializeDeepnoteFile(externalProject1));

        onDidChangeFile.fire(uri);
        await waitFor(() => saveCount >= 1);
        assert.isAtLeast(applyEditCount, 1, 'Step 2: first external edit should reload');

        const applyCountAfterFirstReload = applyEditCount;

        // Consume FS events from executeMainFileSync's writeFile + save
        onDidChangeFile.fire(uri);
        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

        // Step 3: editor edit → user saves again
        onDidSaveNotebook.fire(notebook);
        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

        // Step 4: second external edit → should reload but phantom self-write blocks it
        const externalProject2 = structuredClone(multiNotebookProject);
        externalProject2.project.notebooks[0].blocks![0].content = 'print("external-2")';
        setupMockFs(serializeDeepnoteFile(externalProject2));

        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, debounceWaitMs + 500));

        assert.isAbove(
            applyEditCount,
            applyCountAfterFirstReload,
            'Step 4: second external edit should reload, but phantom self-write from executeMainFileSync leaks and suppresses it'
        );
    });

    test('should use atomic edit (single applyEdit for replaceCells + metadata)', async () => {
        const uri = testFileUri('test.deepnote');
        const notebook = createMockNotebook({ uri, cellCount: 0 });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        await waitFor(() => applyEditCount > 0);

        // Only ONE applyEdit call (atomic: replaceCells + metadata in single WorkspaceEdit)
        assert.strictEqual(applyEditCount, 1, 'applyEdit should be called exactly once (atomic edit)');
    });

    test('should skip auto-save-triggered changes via content comparison', async () => {
        const uri = testFileUri('test.deepnote');
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
            when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
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
            when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall((uri: Uri) => {
                snapshotSaveCount++;
                return Promise.resolve(uri);
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');

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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');

            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called when disabled');
        });

        test('should debounce rapid snapshot changes for same project', async () => {
            const snapshotUri1 = testFileUri('snapshots', 'my-project_project-1_2025-01-15T10-31-48.snapshot.deepnote');
            const snapshotUri2 = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
                uri: testFileUri('test.deepnote'),
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const existingOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebookUri = testFileUri('test.deepnote');
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const existingOutput = { items: [{ mime: 'text/plain', data: new Uint8Array([72]) }] };
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            // Create a mock notebook manager that returns an original project
            const mockedManager = mock<IDeepnoteNotebookManager>();
            when(mockedManager.getOriginalProject('project-1', anything())).thenReturn({
                version: '1.0',
                metadata: { createdAt: '2025-01-01T00:00:00Z' },
                project: {
                    id: 'project-1',
                    name: 'Test Project',
                    notebooks: [
                        {
                            id: 'notebook-1',
                            name: 'Notebook 1',
                            blocks: [{ id: 'block-1', type: 'code', sortingKey: 'a0' }]
                        }
                    ]
                }
            } as DeepnoteProject);

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

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            // Cell has NO id in metadata — simulates VS Code losing metadata after replaceCells
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
                metadata: { deepnoteProjectId: 'project-1', deepnoteNotebookId: 'notebook-1' },
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
            when(mockSnapshotService.readSnapshot(anything())).thenReturn(Promise.resolve(newOutputs));

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
            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');

            // Two cells: block-1 has no outputs (will get updated), block-2 already has matching outputs
            const outputItem = {
                mime: 'text/plain',
                data: new TextEncoder().encode('Existing output')
            };
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
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

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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
            const noFallbackDisposables: IDisposableRegistry = [];
            const noFallbackOnDidChange = new EventEmitter<Uri>();
            const noFallbackOnDidCreate = new EventEmitter<Uri>();
            const fsWatcherNf = mock<FileSystemWatcher>();
            when(fsWatcherNf.onDidChange).thenReturn(noFallbackOnDidChange.event);
            when(fsWatcherNf.onDidCreate).thenReturn(noFallbackOnDidCreate.event);
            when(fsWatcherNf.dispose()).thenReturn();
            when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(
                instance(fsWatcherNf)
            );

            let nfApplyEditCount = 0;
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                nfApplyEditCount++;
                return Promise.resolve(true);
            });

            let nfReadSnapshotCount = 0;
            const nfSnapshotService = mock<SnapshotService>();
            when(nfSnapshotService.isSnapshotsEnabled()).thenReturn(true);
            when(nfSnapshotService.readSnapshot(anything())).thenCall(() => {
                nfReadSnapshotCount++;
                return Promise.resolve(snapshotOutputs);
            });
            when(nfSnapshotService.onFileWritten(anything())).thenReturn({ dispose: () => {} } as Disposable);

            const nfManager = mock<IDeepnoteNotebookManager>();
            when(nfManager.getOriginalProject(anything(), anything())).thenReturn(undefined);

            const nfWatcher = new DeepnoteFileChangeWatcher(
                noFallbackDisposables,
                instance(nfManager),
                instance(nfSnapshotService)
            );
            nfWatcher.activate();

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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

            noFallbackOnDidChange.fire(snapshotUri);

            await waitFor(() => nfReadSnapshotCount >= 1);
            await new Promise((resolve) => setTimeout(resolve, postSnapshotReadGraceMs));

            assert.isAtLeast(nfReadSnapshotCount, 1, 'readSnapshot should be called');
            assert.strictEqual(nfApplyEditCount, 0, 'applyEdit should NOT be called when no block IDs can be resolved');

            for (const d of noFallbackDisposables) {
                d.dispose();
            }
            noFallbackOnDidChange.dispose();
            noFallbackOnDidCreate.dispose();
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

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('test.deepnote'),
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

        test('should not save when metadata restore fails after replaceCells fallback', async () => {
            const mdDisposables: IDisposableRegistry = [];
            const mdOnDidChange = new EventEmitter<Uri>();
            const mdOnDidCreate = new EventEmitter<Uri>();
            const fsWatcherMd = mock<FileSystemWatcher>();
            when(fsWatcherMd.onDidChange).thenReturn(mdOnDidChange.event);
            when(fsWatcherMd.onDidCreate).thenReturn(mdOnDidCreate.event);
            when(fsWatcherMd.dispose()).thenReturn();
            when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(
                instance(fsWatcherMd)
            );

            let mdApplyEditInvocation = 0;
            let mdSaveCount = 0;
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                mdApplyEditInvocation++;
                return Promise.resolve(mdApplyEditInvocation === 1);
            });
            when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall((uri: Uri) => {
                mdSaveCount++;
                return Promise.resolve(uri);
            });

            const mockedControllerRegistration = mock<IControllerRegistration>();
            when(mockedControllerRegistration.getSelected(anything())).thenReturn(undefined);

            const mdWatcher = new DeepnoteFileChangeWatcher(
                mdDisposables,
                mockNotebookManager,
                instance(mockSnapshotService),
                instance(mockedControllerRegistration)
            );
            mdWatcher.activate();

            const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: testFileUri('metadata-fail-replace.deepnote'),
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

            mdOnDidChange.fire(snapshotUri);

            await waitFor(() => mdApplyEditInvocation >= 2);

            assert.strictEqual(
                mdApplyEditInvocation,
                2,
                'replaceCells and metadata restore should each invoke applyEdit once'
            );
            assert.strictEqual(
                mdSaveCount,
                0,
                'workspace.save must not run when metadata restore fails (would persist wrong cell IDs)'
            );

            for (const d of mdDisposables) {
                d.dispose();
            }
            mdOnDidChange.dispose();
            mdOnDidCreate.dispose();
        });

        test('should warn and return when metadata restore fails after execution API with block ID fallback', async () => {
            const warnStub = sinon.stub(logger, 'warn');

            try {
                const exMdDisposables: IDisposableRegistry = [];
                const exMdOnDidChange = new EventEmitter<Uri>();
                const exMdOnDidCreate = new EventEmitter<Uri>();
                const fsWatcherExMd = mock<FileSystemWatcher>();
                when(fsWatcherExMd.onDidChange).thenReturn(exMdOnDidChange.event);
                when(fsWatcherExMd.onDidCreate).thenReturn(exMdOnDidCreate.event);
                when(fsWatcherExMd.dispose()).thenReturn();
                when(mockedVSCodeNamespaces.workspace.createFileSystemWatcher(anything())).thenReturn(
                    instance(fsWatcherExMd)
                );

                let exMdSaveCount = 0;
                when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(false));
                when(mockedVSCodeNamespaces.workspace.save(anything())).thenCall((uri: Uri) => {
                    exMdSaveCount++;
                    return Promise.resolve(uri);
                });

                const mockVSCodeController = {
                    createNotebookCellExecution: () => ({
                        start: () => {},
                        replaceOutput: () => Promise.resolve(),
                        end: () => {}
                    })
                };
                const mockedControllerRegistration = mock<IControllerRegistration>();
                when(mockedControllerRegistration.getSelected(anything())).thenReturn({
                    controller: mockVSCodeController
                } as any);

                const mockedManagerEx = mock<IDeepnoteNotebookManager>();
                when(mockedManagerEx.getOriginalProject(anything(), anything())).thenReturn(validProject);
                when(mockedManagerEx.updateOriginalProject(anything(), anything(), anything())).thenReturn();

                const exMdWatcher = new DeepnoteFileChangeWatcher(
                    exMdDisposables,
                    instance(mockedManagerEx),
                    instance(mockSnapshotService),
                    instance(mockedControllerRegistration)
                );
                exMdWatcher.activate();

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                const notebook = createMockNotebook({
                    uri: testFileUri('metadata-fail-exec.deepnote'),
                    cells: [
                        {
                            metadata: { type: 'code' },
                            outputs: [],
                            kind: NotebookCellKind.Code,
                            document: { getText: () => 'print("hello")' }
                        }
                    ]
                });

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

                exMdOnDidChange.fire(snapshotUri);

                await waitFor(() => warnStub.called);

                assert.include(
                    warnStub.firstCall.args[0] as string,
                    'Failed to restore block IDs via execution path',
                    'should log when metadata restore fails after execution API'
                );
                assert.strictEqual(
                    exMdSaveCount,
                    0,
                    'execution API path should not save after failed metadata restore'
                );

                for (const d of exMdDisposables) {
                    d.dispose();
                }
                exMdOnDidChange.dispose();
                exMdOnDidCreate.dispose();
            } finally {
                warnStub.restore();
            }
        });

        test('refreshes open notebook when only notebook-scoped latest snapshot exists on disk', async () => {
            // Catches: queued snapshot work dropped the notebook ID from the filename and called readSnapshot(projectId), so notebook-scoped latest files returned no outputs and the editor never refreshed.
            const scopedNotebookId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            const snapshotUri = testFileUri('snapshots', `proj_project-1_${scopedNotebookId}_latest.snapshot.deepnote`);

            resetCalls(mockSnapshotService);
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);
            when(mockSnapshotService.readSnapshot(anything(), anything())).thenCall((pid: string, nid?: string) => {
                readSnapshotCallCount++;
                if (typeof nid === 'undefined') {
                    return Promise.resolve(undefined);
                }
                if (pid === 'project-1' && nid === scopedNotebookId) {
                    return Promise.resolve(snapshotOutputs);
                }

                return Promise.resolve(undefined);
            });

            const notebook = createMockNotebook({
                uri: testFileUri('scoped-snapshot-only.deepnote'),
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: scopedNotebookId
                },
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

            snapshotApplyEditCount = 0;
            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount > 0);

            assert.isAtLeast(readSnapshotCallCount, 1, 'readSnapshot should be called');
            assert.isAtLeast(
                snapshotApplyEditCount,
                1,
                'applyEdit should refresh outputs from notebook-scoped snapshot'
            );
        });

        test('applies notebook-scoped latest snapshot only to the open notebook whose ID matches the filename', async () => {
            // Catches: readSnapshot omitted the notebook ID from the snapshot path, so sibling notebooks in the same project could be updated from the wrong snapshot scope or the targeted notebook read no outputs.
            const nb1Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
            const nb2Id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

            resetCalls(mockSnapshotService);
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);

            const readArgs: Array<{ projectId: string; notebookId?: string }> = [];
            const nb1Outputs = new Map<string, DeepnoteOutput[]>([
                [
                    'block-nb1',
                    [
                        {
                            output_type: 'execute_result',
                            data: { 'text/plain': 'ForNb1Only' },
                            execution_count: 1
                        } as DeepnoteOutput
                    ]
                ]
            ]);
            const nb2Outputs = new Map<string, DeepnoteOutput[]>([
                [
                    'block-nb2',
                    [
                        {
                            output_type: 'execute_result',
                            data: { 'text/plain': 'ForNb2Only' },
                            execution_count: 1
                        } as DeepnoteOutput
                    ]
                ]
            ]);

            when(mockSnapshotService.readSnapshot(anything(), anything())).thenCall((pid: string, nid?: string) => {
                readSnapshotCallCount++;
                readArgs.push({ projectId: pid, notebookId: nid });
                if (nid === nb1Id) {
                    return Promise.resolve(nb1Outputs);
                }
                if (nid === nb2Id) {
                    return Promise.resolve(nb2Outputs);
                }

                return Promise.resolve(undefined);
            });

            when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(multiNotebookProject);

            const uriNb1 = testFileUri('multi-scope-nb1.deepnote');
            const uriNb2 = testFileUri('multi-scope-nb2.deepnote');
            const notebook1 = createMockNotebook({
                uri: uriNb1,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: nb1Id
                },
                cells: [
                    {
                        metadata: { id: 'block-nb1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb1")', languageId: 'python' }
                    }
                ]
            });
            const notebook2 = createMockNotebook({
                uri: uriNb2,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: nb2Id
                },
                cells: [
                    {
                        metadata: { id: 'block-nb2', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb2")', languageId: 'python' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);

            const snapshotUri = testFileUri('snapshots', `proj_project-1_${nb1Id}_latest.snapshot.deepnote`);

            snapshotApplyEditCount = 0;
            snapshotOnDidChange.fire(snapshotUri);

            await waitFor(() => snapshotApplyEditCount >= 2);

            assert.deepStrictEqual(readArgs, [{ projectId: 'project-1', notebookId: nb1Id }]);
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'only the matching open notebook should receive snapshot edits'
            );
        });

        suite('snapshot and deserialization interaction', () => {
            let interactionCaptures: SnapshotInteractionCapture[];
            let snapshotApplyEditStub: sinon.SinonStub;

            setup(() => {
                interactionCaptures = [];

                reset(mockedNotebookManager);
                when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(validProject);
                when(mockedNotebookManager.updateOriginalProject(anything(), anything(), anything())).thenReturn();
                resetCalls(mockedNotebookManager);

                snapshotApplyEditStub = sinon.stub(snapshotWatcher, 'applyNotebookEdits').callsFake(async function (
                    this: DeepnoteFileChangeWatcher,
                    ...args: unknown[]
                ) {
                    const uri = args[0] as Uri;
                    const edits = args[1] as NotebookEdit[];

                    const replaceCellsEdit = edits.find((e) => (e as { newCells?: unknown[] }).newCells?.length);
                    if (replaceCellsEdit) {
                        const newCells = (
                            replaceCellsEdit as {
                                newCells: Array<{
                                    outputs?: Array<{ items: Array<{ data?: Uint8Array }> }>;
                                    value: string;
                                }>;
                            }
                        ).newCells;
                        const outputPlainJoined = newCells
                            .map((c) => {
                                const data = c.outputs?.[0]?.items?.[0]?.data;

                                return data ? new TextDecoder().decode(data) : '';
                            })
                            .filter(Boolean)
                            .join(';');

                        interactionCaptures.push({
                            uriKey: uri.toString(),
                            cellSourcesJoined: newCells.map((c) => c.value).join('\n'),
                            outputPlainJoined
                        });
                    }

                    return DeepnoteFileChangeWatcher.prototype.applyNotebookEdits.apply(this, [uri, edits]);
                });
            });

            teardown(() => {
                snapshotApplyEditStub.restore();
            });

            test('snapshot change with multi-notebook project applies only matching block outputs per notebook', async () => {
                when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(multiNotebookProject);

                const multiOutputs = new Map<string, DeepnoteOutput[]>([
                    [
                        'block-nb1',
                        [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': 'OutputForNb1Only' },
                                execution_count: 1
                            } as DeepnoteOutput
                        ]
                    ],
                    [
                        'block-nb2',
                        [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': 'OutputForNb2Only' },
                                execution_count: 1
                            } as DeepnoteOutput
                        ]
                    ]
                ]);
                when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
                    readSnapshotCallCount++;

                    return Promise.resolve(multiOutputs);
                });

                const basePath = testFileUri('multi-snap.deepnote');
                const uriNb1 = basePath.with({ query: 'view=1' });
                const uriNb2 = basePath.with({ query: 'view=2' });

                const notebook1 = createMockNotebook({
                    uri: uriNb1,
                    metadata: {
                        deepnoteProjectId: 'project-1',
                        deepnoteNotebookId: 'notebook-1'
                    },
                    cells: [
                        {
                            metadata: { id: 'block-nb1', type: 'code' },
                            outputs: [],
                            kind: NotebookCellKind.Code,
                            document: { getText: () => 'print("nb1-old")', languageId: 'python' }
                        }
                    ]
                });

                const notebook2 = createMockNotebook({
                    uri: uriNb2,
                    metadata: {
                        deepnoteProjectId: 'project-1',
                        deepnoteNotebookId: 'notebook-2'
                    },
                    cells: [
                        {
                            metadata: { id: 'block-nb2', type: 'code' },
                            outputs: [],
                            kind: NotebookCellKind.Code,
                            document: { getText: () => 'print("nb2-old")', languageId: 'python' }
                        }
                    ]
                });

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                snapshotOnDidChange.fire(snapshotUri);

                await waitFor(() => snapshotApplyEditCount >= 4);

                const byUri = new Map(interactionCaptures.map((c) => [c.uriKey, c]));

                assert.include(byUri.get(uriNb1.toString())?.outputPlainJoined ?? '', 'OutputForNb1Only');
                assert.notInclude(byUri.get(uriNb1.toString())?.outputPlainJoined ?? '', 'OutputForNb2Only');

                assert.include(byUri.get(uriNb2.toString())?.outputPlainJoined ?? '', 'OutputForNb2Only');
                assert.notInclude(byUri.get(uriNb2.toString())?.outputPlainJoined ?? '', 'OutputForNb1Only');
            });

            test('main file change after snapshot update deserializes updated cell source', async function () {
                this.timeout(10_000);
                const notebookUri = testFileUri('after-snap.deepnote');
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

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
                    readSnapshotCallCount++;

                    return Promise.resolve(snapshotOutputs);
                });

                snapshotOnDidChange.fire(snapshotUri);
                await waitFor(() => snapshotApplyEditCount >= 2);

                const changedYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: project-1
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("after-snapshot-main-sync")
`;

                const mockFs = mock<typeof import('vscode').workspace.fs>();
                when(mockFs.readFile(anything())).thenCall(() => {
                    return Promise.resolve(new TextEncoder().encode(changedYaml));
                });
                when(mockFs.writeFile(anything(), anything())).thenReturn(Promise.resolve());
                when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

                // Snapshot save marks self-write; first FS event consumes it without reloading.
                snapshotOnDidChange.fire(notebookUri);
                await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

                snapshotOnDidChange.fire(notebookUri);

                await waitFor(() =>
                    interactionCaptures.some((c) => c.cellSourcesJoined.includes('after-snapshot-main-sync'))
                );

                const mainSyncCapture = interactionCaptures.find((c) =>
                    c.cellSourcesJoined.includes('after-snapshot-main-sync')
                );

                assert.isDefined(mainSyncCapture);
                assert.include(
                    mainSyncCapture!.cellSourcesJoined,
                    'after-snapshot-main-sync',
                    'main-file sync should deserialize new source after snapshot outputs were applied'
                );
            });

            test('snapshot save self-write is consumed once then external main-file change applies', async function () {
                this.timeout(10_000);
                const baseUri = testFileUri('snap-self-write.deepnote');
                const notebook = createMockNotebook({
                    uri: baseUri,
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

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                snapshotOnDidChange.fire(snapshotUri);
                await waitFor(() => snapshotSaveCount >= 1);

                const editsBefore = snapshotApplyEditCount;

                snapshotOnDidChange.fire(baseUri);
                await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

                assert.strictEqual(
                    snapshotApplyEditCount,
                    editsBefore,
                    'first main-file FS event after snapshot save should be consumed as self-write'
                );

                const externalYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: project-1
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("external-after-self-write")
`;

                const mockFs = mock<typeof import('vscode').workspace.fs>();
                when(mockFs.readFile(anything())).thenCall(() => {
                    return Promise.resolve(new TextEncoder().encode(externalYaml));
                });
                when(mockFs.writeFile(anything(), anything())).thenReturn(Promise.resolve());
                when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

                snapshotOnDidChange.fire(baseUri);

                await waitFor(() =>
                    interactionCaptures.some((c) => c.cellSourcesJoined.includes('external-after-self-write'))
                );

                assert.isTrue(
                    interactionCaptures.some((c) => c.cellSourcesJoined.includes('external-after-self-write')),
                    'second main-file change should deserialize external content'
                );
            });

            test('main-file sync runs after in-flight snapshot when both are triggered close together', async function () {
                this.timeout(12_000);
                let releaseSnapshot!: () => void;
                const snapshotGate = new Promise<void>((resolve) => {
                    releaseSnapshot = resolve;
                });

                when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
                    readSnapshotCallCount++;

                    return snapshotGate.then(() => snapshotOutputs);
                });

                const baseUri = testFileUri('coalesce.deepnote');
                const notebook = createMockNotebook({
                    uri: baseUri,
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

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                snapshotOnDidChange.fire(snapshotUri);

                await waitFor(() => readSnapshotCallCount >= 1);

                const coalescedYaml = `
version: '1.0.0'
metadata:
  createdAt: '2025-01-01T00:00:00Z'
project:
  id: project-1
  name: Test Project
  notebooks:
    - id: notebook-1
      name: Notebook 1
      blocks:
        - id: block-1
          type: code
          sortingKey: a0
          blockGroup: '1'
          content: print("main-wins-after-snapshot")
`;

                const mockFs = mock<typeof import('vscode').workspace.fs>();
                when(mockFs.readFile(anything())).thenCall(() => {
                    return Promise.resolve(new TextEncoder().encode(coalescedYaml));
                });
                when(mockFs.writeFile(anything(), anything())).thenReturn(Promise.resolve());
                when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

                snapshotOnDidChange.fire(baseUri);
                await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

                releaseSnapshot();

                await waitFor(() =>
                    interactionCaptures.some((c) => c.cellSourcesJoined.includes('main-wins-after-snapshot'))
                );

                assert.isTrue(
                    interactionCaptures.some((c) => c.cellSourcesJoined.includes('main-wins-after-snapshot')),
                    'main-file sync should deserialize disk YAML after snapshot operation completes'
                );
            });

            // Multi-notebook test removed — multi-notebook support has been replaced by auto-splitting into separate files
            test.skip('multi-notebook: snapshot outputs then external YAML update keeps per-notebook sources', async function () {
                this.timeout(12_000);
                when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(multiNotebookProject);

                const multiOutputs = new Map<string, DeepnoteOutput[]>([
                    [
                        'block-nb1',
                        [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': 'SnapNb1' },
                                execution_count: 1
                            } as DeepnoteOutput
                        ]
                    ],
                    [
                        'block-nb2',
                        [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': 'SnapNb2' },
                                execution_count: 1
                            } as DeepnoteOutput
                        ]
                    ]
                ]);
                when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
                    readSnapshotCallCount++;

                    return Promise.resolve(multiOutputs);
                });

                const basePath = testFileUri('multi-snap-then-yaml.deepnote');
                const uriNb1 = basePath.with({ query: 'view=1' });
                const uriNb2 = basePath.with({ query: 'view=2' });

                const notebook1 = createMockNotebook({
                    uri: uriNb1,
                    metadata: {
                        deepnoteProjectId: 'project-1',
                        deepnoteNotebookId: 'notebook-1'
                    },
                    cells: [
                        {
                            metadata: { id: 'block-nb1', type: 'code' },
                            outputs: [],
                            kind: NotebookCellKind.Code,
                            document: { getText: () => 'print("nb1-old")', languageId: 'python' }
                        }
                    ]
                });

                const notebook2 = createMockNotebook({
                    uri: uriNb2,
                    metadata: {
                        deepnoteProjectId: 'project-1',
                        deepnoteNotebookId: 'notebook-2'
                    },
                    cells: [
                        {
                            metadata: { id: 'block-nb2', type: 'code' },
                            outputs: [],
                            kind: NotebookCellKind.Code,
                            document: { getText: () => 'print("nb2-old")', languageId: 'python' }
                        }
                    ]
                });

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                snapshotOnDidChange.fire(snapshotUri);
                await waitFor(() => snapshotApplyEditCount >= 4);

                const round2Project = structuredClone(multiNotebookProject);
                round2Project.project.notebooks[0].blocks![0].content = 'print("nb1-round2")';
                round2Project.project.notebooks[1].blocks![0].content = 'print("nb2-round2")';
                const yamlRound2 = serializeDeepnoteFile(round2Project);

                const mockFs = mock<typeof import('vscode').workspace.fs>();
                when(mockFs.readFile(anything())).thenCall(() => {
                    return Promise.resolve(new TextEncoder().encode(yamlRound2));
                });
                when(mockFs.writeFile(anything(), anything())).thenReturn(Promise.resolve());
                when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

                // Two snapshot saves increment self-write count to 2 for the shared base file URI.
                snapshotOnDidChange.fire(basePath);
                await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));
                snapshotOnDidChange.fire(basePath);
                await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

                snapshotOnDidChange.fire(basePath);

                await waitFor(() =>
                    interactionCaptures.some(
                        (c) => c.uriKey === uriNb1.toString() && c.cellSourcesJoined.includes('nb1-round2')
                    )
                );

                assert.isTrue(
                    interactionCaptures.some(
                        (c) => c.uriKey === uriNb1.toString() && c.outputPlainJoined.includes('SnapNb1')
                    ),
                    'snapshot phase should apply SnapNb1 output to notebook-1'
                );
                assert.isTrue(
                    interactionCaptures.some(
                        (c) => c.uriKey === uriNb2.toString() && c.outputPlainJoined.includes('SnapNb2')
                    ),
                    'snapshot phase should apply SnapNb2 output to notebook-2'
                );

                const nb1Main = interactionCaptures.find(
                    (c) => c.uriKey === uriNb1.toString() && c.cellSourcesJoined.includes('nb1-round2')
                );
                const nb2Main = interactionCaptures.find(
                    (c) => c.uriKey === uriNb2.toString() && c.cellSourcesJoined.includes('nb2-round2')
                );

                assert.isDefined(nb1Main);
                assert.include(nb1Main!.cellSourcesJoined, 'nb1-round2');
                assert.notInclude(nb1Main!.cellSourcesJoined, 'nb2-round2');

                assert.isDefined(nb2Main);
                assert.include(nb2Main!.cellSourcesJoined, 'nb2-round2');
                assert.notInclude(nb2Main!.cellSourcesJoined, 'nb1-round2');
            });

            test('snapshot outputs for sibling notebook blocks do not leak into a single open notebook', async () => {
                when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(multiNotebookProject);

                const multiOutputs = new Map<string, DeepnoteOutput[]>([
                    [
                        'block-nb1',
                        [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': 'OnlyNb1' },
                                execution_count: 1
                            } as DeepnoteOutput
                        ]
                    ],
                    [
                        'block-nb2',
                        [
                            {
                                output_type: 'execute_result',
                                data: { 'text/plain': 'LeakIfApplied' },
                                execution_count: 1
                            } as DeepnoteOutput
                        ]
                    ]
                ]);
                when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
                    readSnapshotCallCount++;

                    return Promise.resolve(multiOutputs);
                });

                const uriNb1 = testFileUri('only-nb1.deepnote');
                const notebook1Only = createMockNotebook({
                    uri: uriNb1,
                    metadata: {
                        deepnoteProjectId: 'project-1',
                        deepnoteNotebookId: 'notebook-1'
                    },
                    cells: [
                        {
                            metadata: { id: 'block-nb1', type: 'code' },
                            outputs: [],
                            kind: NotebookCellKind.Code,
                            document: { getText: () => 'print("nb1-only")', languageId: 'python' }
                        }
                    ]
                });

                when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1Only]);

                const snapshotUri = testFileUri('snapshots', 'my-project_project-1_latest.snapshot.deepnote');
                snapshotOnDidChange.fire(snapshotUri);

                await waitFor(() => snapshotApplyEditCount >= 2);

                const cap = interactionCaptures.find((c) => c.uriKey === uriNb1.toString());

                assert.isDefined(cap);
                assert.include(cap!.outputPlainJoined, 'OnlyNb1');
                assert.notInclude(cap!.outputPlainJoined, 'LeakIfApplied');
            });
        });
    });

    // Multi-notebook file sync tests removed — multi-notebook support has been replaced by auto-splitting into separate files
    suite.skip('multi-notebook file sync', () => {
        let workspaceSetCaptures: NotebookEditCapture[] = [];

        setup(() => {
            reset(mockedNotebookManager);
            when(mockedNotebookManager.getOriginalProject(anything(), anything())).thenReturn(multiNotebookProject);
            when(mockedNotebookManager.updateOriginalProject(anything(), anything(), anything())).thenReturn();
            resetCalls(mockedNotebookManager);
            workspaceSetCaptures = [];
            sinon.stub(watcher, 'applyNotebookEdits' as any).callsFake(async (...args: unknown[]) => {
                const uri = args[0] as Uri;
                const edits = args[1] as NotebookEdit[];

                applyEditCount++;

                const replaceCellsEdit = edits.find((e) => e.newCells?.length > 0);
                if (replaceCellsEdit) {
                    workspaceSetCaptures.push({
                        uriKey: uri.toString(),
                        cellSourceJoined: replaceCellsEdit.newCells.map((c: any) => c.value).join('\n')
                    });
                }

                return true;
            });
        });

        test('should reload each notebook with its own content when multiple notebooks are open', async () => {
            const basePath = testFileUri('multi.deepnote');
            const uriNb1 = basePath.with({ query: 'view=1' });
            const uriNb2 = basePath.with({ query: 'view=2' });

            const notebook1 = createMockNotebook({
                uri: uriNb1,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-1'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb1-old")', languageId: 'python' }
                    }
                ]
            });

            const notebook2 = createMockNotebook({
                uri: uriNb2,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-2'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb2', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb2-old")', languageId: 'python' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
            setupMockFs(multiNotebookYaml);

            onDidChangeFile.fire(basePath);

            await waitFor(() => applyEditCount >= 2);

            assert.strictEqual(applyEditCount, 2, 'applyEdit should run once per open notebook');
            assert.strictEqual(workspaceSetCaptures.length, 2, 'each notebook should get a replaceCells edit');

            const byUri = new Map(workspaceSetCaptures.map((c) => [c.uriKey, c.cellSourceJoined]));

            assert.include(byUri.get(uriNb1.toString()) ?? '', 'nb1-new');
            assert.notInclude(byUri.get(uriNb1.toString()) ?? '', 'nb2-new');
            assert.include(byUri.get(uriNb2.toString()) ?? '', 'nb2-new');
            assert.notInclude(byUri.get(uriNb2.toString()) ?? '', 'nb1-new');
        });

        test('should not clear notebook selection before processing file change', async () => {
            const basePath = testFileUri('multi.deepnote');
            const uriNb1 = basePath.with({ query: 'a=1' });
            const uriNb2 = basePath.with({ query: 'b=2' });

            const notebook1 = createMockNotebook({
                uri: uriNb1,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-1'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb1' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb1-old")' }
                    }
                ]
            });

            const notebook2 = createMockNotebook({
                uri: uriNb2,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-2'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb2' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb2-old")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
            setupMockFs(multiNotebookYaml);

            onDidChangeFile.fire(basePath);

            await waitFor(() => applyEditCount >= 2);
        });

        test('should not corrupt other notebooks when one notebook triggers a file change', async () => {
            const basePath = testFileUri('multi.deepnote');
            const uriNb1 = basePath.with({ query: 'n=1' });
            const uriNb2 = basePath.with({ query: 'n=2' });

            const notebook1 = createMockNotebook({
                uri: uriNb1,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-1'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb1' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb1-old")' }
                    }
                ]
            });

            const notebook2 = createMockNotebook({
                uri: uriNb2,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-2'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb2' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb2-old")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
            setupMockFs(multiNotebookYaml);

            onDidChangeFile.fire(basePath);

            await waitFor(() => applyEditCount >= 2);

            const nb1Cells = workspaceSetCaptures.find((c) => c.uriKey === uriNb1.toString())?.cellSourceJoined;
            const nb2Cells = workspaceSetCaptures.find((c) => c.uriKey === uriNb2.toString())?.cellSourceJoined;

            assert.isDefined(nb1Cells);
            assert.isDefined(nb2Cells);
            assert.notStrictEqual(nb1Cells, nb2Cells, 'each open notebook must receive distinct deserialized content');

            assert.include(nb1Cells!, 'nb1-new');
            assert.include(nb2Cells!, 'nb2-new');
            assert.notInclude(nb1Cells!, 'nb2-new', 'notebook-1 must not receive notebook-2 block content');
            assert.notInclude(nb2Cells!, 'nb1-new', 'notebook-2 must not receive notebook-1 block content');
        });

        test('external edit to disk should update each open notebook and not be suppressed as self-write', async () => {
            const basePath = testFileUri('multi-external.deepnote');
            const uriNb1 = basePath.with({ query: 'view=1' });
            const uriNb2 = basePath.with({ query: 'view=2' });

            const notebook1 = createMockNotebook({
                uri: uriNb1,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-1'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb1', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb1-old")', languageId: 'python' }
                    }
                ]
            });

            const notebook2 = createMockNotebook({
                uri: uriNb2,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-2'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb2', type: 'code' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb2-old")', languageId: 'python' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
            setupMockFs(multiNotebookYaml);

            onDidChangeFile.fire(basePath);

            await waitFor(() => applyEditCount >= 2);

            const byUri = new Map(workspaceSetCaptures.map((c) => [c.uriKey, c.cellSourceJoined]));

            assert.include(byUri.get(uriNb1.toString()) ?? '', 'nb1-new');
            assert.include(byUri.get(uriNb2.toString()) ?? '', 'nb2-new');
        });

        test('external edit after a user save should still be processed', async function () {
            this.timeout(8000);
            const basePath = testFileUri('multi-save-then-external.deepnote');
            const uriNb1 = basePath.with({ query: 'view=1' });
            const uriNb2 = basePath.with({ query: 'view=2' });

            const notebook1 = createMockNotebook({
                uri: uriNb1,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-1'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb1' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb1-old")' }
                    }
                ]
            });

            const notebook2 = createMockNotebook({
                uri: uriNb2,
                metadata: {
                    deepnoteProjectId: 'project-1',
                    deepnoteNotebookId: 'notebook-2'
                },
                cells: [
                    {
                        metadata: { id: 'block-nb2' },
                        outputs: [],
                        kind: NotebookCellKind.Code,
                        document: { getText: () => 'print("nb2-old")' }
                    }
                ]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook1, notebook2]);
            setupMockFs(multiNotebookYaml);

            onDidSaveNotebook.fire(notebook1);
            onDidChangeFile.fire(basePath);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(applyEditCount, 0, 'first FS event after save should be suppressed as self-write');

            onDidChangeFile.fire(basePath);

            await waitFor(() => applyEditCount >= 1);

            assert.isAtLeast(applyEditCount, 1);
        });
    });
});
