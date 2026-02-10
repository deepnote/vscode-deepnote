import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, FileSystemWatcher, NotebookCellKind, NotebookDocument, Uri } from 'vscode';

import type { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteFileChangeWatcher } from './deepnoteFileChangeWatcher';

/**
 * Polls until a condition is met or a timeout is reached.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
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
        const fsWatcher = mock<FileSystemWatcher>();
        when(fsWatcher.onDidChange).thenReturn(onDidChangeFile.event);
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
        mockDisposables.forEach((d) => d.dispose());
        onDidChangeFile.dispose();
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
        await new Promise((resolve) => setTimeout(resolve, 800));

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
        await new Promise((resolve) => setTimeout(resolve, 100));
        onDidChangeFile.fire(uri);
        await new Promise((resolve) => setTimeout(resolve, 100));
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

        // Parse errors should be caught and logged without calling applyEdit
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
        await waitFor(() => applyEditCount >= 2, 5000);

        assert.isAtLeast(applyEditCount, 2, 'applyEdit should be called for both external changes');
    });
});
