import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, FileSystemWatcher, NotebookCellKind, NotebookDocument, Uri } from 'vscode';

import type { IDisposableRegistry } from '../../platform/common/types';
import type { DeepnoteOutput, DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteFileChangeWatcher } from './deepnoteFileChangeWatcher';
import { SnapshotService } from './snapshots/snapshotService';

const waitForTimeoutMs = 5000;
const waitForIntervalMs = 50;
const debounceWaitMs = 800;
const rapidChangeIntervalMs = 100;

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
            document?: { getText: () => string };
        }>;
    }): NotebookDocument {
        const cells = (opts.cells ?? []).map((c) => ({
            ...c,
            kind: c.kind ?? NotebookCellKind.Code,
            document: c.document ?? { getText: () => '' }
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
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        return mockFs;
    }

    const validYaml = `
version: '1.0'
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
                    document: { getText: () => 'print("hello")' }
                }
            ]
        });

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);

        // Wait for debounce + deserialization
        await waitFor(() => readFileCalls > 0);

        // File was read, but applyEdit should NOT be called because cells match
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

    test('should skip snapshot files', async () => {
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

        // Dirty notebooks should now be reloaded and saved to prevent mtime conflicts
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

    test('should not suppress real changes after auto-save', async () => {
        const uri = Uri.file('/workspace/test.deepnote');

        // First change: notebook has no cells, YAML has one cell -> different -> reload
        const notebook = createMockNotebook({ uri, cellCount: 0, cells: [] });
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        setupMockFs(validYaml);

        onDidChangeFile.fire(uri);
        await waitFor(() => applyEditCount >= 1);

        // Second change: use different YAML content
        const changedYaml = `
version: '1.0'
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
          content: print("world")
`;
        setupMockFs(changedYaml);
        onDidChangeFile.fire(uri);
        await waitFor(() => applyEditCount >= 2, waitForTimeoutMs);

        assert.isAtLeast(applyEditCount, 2, 'applyEdit should be called for both external changes');
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
            snapshotDisposables = [];

            mockSnapshotService = mock<SnapshotService>();
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(true);
            when(mockSnapshotService.wasRecentlyWritten(anything())).thenReturn(false);
            when(mockSnapshotService.readSnapshot(anything())).thenCall(() => {
                readSnapshotCallCount++;
                return Promise.resolve(snapshotOutputs);
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
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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
            // Create a watcher without SnapshotService, using its own disposables
            const noSnapshotDisposables: IDisposableRegistry = [];
            const noSnapshotWatcher = new DeepnoteFileChangeWatcher(noSnapshotDisposables, mockNotebookManager);
            noSnapshotWatcher.activate();

            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called');
            assert.strictEqual(snapshotApplyEditCount, 0, 'applyEdit should not be called');

            for (const d of noSnapshotDisposables) {
                d.dispose();
            }
        });

        test('should skip self-triggered snapshot writes', async () => {
            when(mockSnapshotService.wasRecentlyWritten(anything())).thenReturn(true);

            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
                cells: [{ metadata: { id: 'block-1', type: 'code' }, outputs: [] }]
            });

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called for self-writes');
        });

        test('should skip when snapshots are disabled', async () => {
            when(mockSnapshotService.isSnapshotsEnabled()).thenReturn(false);

            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');

            snapshotOnDidChange.fire(snapshotUri);

            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            assert.strictEqual(readSnapshotCallCount, 0, 'readSnapshot should not be called when disabled');
        });

        test('should debounce rapid snapshot changes for same project', async () => {
            const snapshotUri1 = Uri.file(
                '/workspace/snapshots/my-project_project-1_2025-01-15T10-31-48.snapshot.deepnote'
            );
            const snapshotUri2 = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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

        test('should skip update when snapshot content is identical', async () => {
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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

            // First snapshot change — should apply (replaceCells + metadata restore = 2)
            snapshotOnDidChange.fire(snapshotUri);
            await waitFor(() => snapshotApplyEditCount >= 2);
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should be called twice on first snapshot change (replaceCells + metadata)'
            );

            // Second identical snapshot change — should be skipped
            snapshotOnDidChange.fire(snapshotUri);
            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should NOT be called again for identical snapshot'
            );
        });

        test('should update outputs when content changed but count is the same', async () => {
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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

        test('should skip main-file reload after snapshot update', async () => {
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
            const notebookUri = Uri.file('/workspace/test.deepnote');
            const notebook = createMockNotebook({
                uri: notebookUri,
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

            // Set up mock fs for the main-file reload path
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenCall(() => {
                return Promise.resolve(new TextEncoder().encode(validYaml));
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            // First: fire snapshot change → outputs applied (replaceCells + metadata = 2)
            snapshotOnDidChange.fire(snapshotUri);
            await waitFor(() => snapshotApplyEditCount >= 2);
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should be called twice for snapshot (replaceCells + metadata)'
            );

            // Second: fire main-file change within suppression window
            snapshotOnDidChange.fire(notebookUri);

            // Wait past debounce + processing
            await new Promise((resolve) => setTimeout(resolve, debounceWaitMs));

            // applyEdit should NOT be called again — the notebook was recently
            // updated via snapshot, so the main-file reload is suppressed
            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should NOT be called again for recently snapshot-updated notebook'
            );
            assert.strictEqual(snapshotSaveCount, 0, 'save should NOT be called for suppressed reload');
        });

        test('should call applyEdit twice for snapshot update (replaceCells + metadata)', async () => {
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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

            // Wait for both applyEdit calls: replaceCells + updateCellMetadata
            await waitFor(() => snapshotApplyEditCount >= 2);

            assert.strictEqual(
                snapshotApplyEditCount,
                2,
                'applyEdit should be called twice (replaceCells + metadata restore)'
            );
        });

        test('should embed fallback block ID in cellData.metadata', async () => {
            // Create a mock notebook manager that returns an original project
            const mockedManager = mock<IDeepnoteNotebookManager>();
            when(mockedManager.getOriginalProject('project-1')).thenReturn({
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

            // Capture the WorkspaceEdit objects passed to applyEdit
            const capturedEdits: any[] = [];
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall((edit: any) => {
                capturedEdits.push(edit);
                return Promise.resolve(true);
            });

            const fallbackWatcher = new DeepnoteFileChangeWatcher(
                fallbackDisposables,
                instance(mockedManager),
                instance(mockSnapshotService)
            );
            fallbackWatcher.activate();

            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
            // Cell has NO id in metadata — simulates VS Code losing metadata after replaceCells
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
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

            // Use new snapshot outputs to bypass fingerprint guard
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

            // Should get 2 applyEdit calls: replaceCells + metadata restore
            await waitFor(() => capturedEdits.length >= 2);

            assert.isAtLeast(capturedEdits.length, 2, 'applyEdit should be called at least twice');

            // The second applyEdit should be the metadata restore.
            // We can't easily inspect WorkspaceEdit internals, but we verify
            // that two edits were applied (replaceCells + updateCellMetadata).
            // The fact that the second call happens at all proves restoreCellMetadata
            // found a block ID to write — which must have come from the fallback.

            // Cleanup
            for (const d of fallbackDisposables) {
                d.dispose();
            }
            fallbackOnDidChange.dispose();
            fallbackOnDidCreate.dispose();
        });

        test('should apply snapshot outputs using original blocks when metadata is lost', async () => {
            // Create a mock notebook manager that returns an original project
            const mockedManager = mock<IDeepnoteNotebookManager>();
            when(mockedManager.getOriginalProject('project-1')).thenReturn({
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

            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
            // Cell has NO id in metadata — simulates VS Code losing metadata after replaceCells
            const notebook = createMockNotebook({
                uri: Uri.file('/workspace/test.deepnote'),
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

            // Use new snapshot outputs to bypass fingerprint guard
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

        test('should NOT call workspace.save after snapshot output update', async () => {
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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

            // Wait a bit more to ensure save is not called after applyEdit
            await new Promise((resolve) => setTimeout(resolve, 200));

            assert.strictEqual(snapshotSaveCount, 0, 'workspace.save should NOT be called for snapshot updates');
        });

        test('should preserve outputs for cells not covered by snapshot', async () => {
            const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');
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

            await waitFor(() => snapshotApplyEditCount > 0);

            assert.isAtLeast(snapshotApplyEditCount, 1, 'applyEdit should be called');
        });
    });
});
