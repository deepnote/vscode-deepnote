import { type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { FileType, Uri, workspace } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteAutoSplitter } from './deepnoteAutoSplitter';

function createDeepnoteFile(notebooks: Array<{ id: string; name: string }>, initNotebookId?: string): DeepnoteFile {
    return {
        metadata: { createdAt: '2025-01-01T00:00:00Z' },
        project: {
            id: 'project-1',
            initNotebookId,
            name: 'Test Project',
            notebooks: notebooks.map(({ id, name }) => ({
                blocks: [],
                executionMode: 'block',
                id,
                name
            }))
        },
        version: '1.0.0'
    };
}

interface FsMockSetup {
    existingPaths: Set<string>;
    writeCalls: Uri[];
}

function setupFsMocks(existingPaths: string[] = []): FsMockSetup {
    const setup: FsMockSetup = {
        existingPaths: new Set(existingPaths),
        writeCalls: []
    };
    const mockFs = mock<typeof workspace.fs>();

    when(mockFs.stat(anything())).thenCall((uri: Uri) => {
        if (setup.existingPaths.has(uri.path)) {
            return Promise.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 } as any);
        }

        return Promise.reject(new Error('ENOENT'));
    });
    when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri) => {
        setup.writeCalls.push(uri);
        setup.existingPaths.add(uri.path);

        return Promise.resolve();
    });
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
    when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(undefined);

    return setup;
}

suite('DeepnoteAutoSplitter', () => {
    let splitter: DeepnoteAutoSplitter;

    setup(() => {
        resetVSCodeMocks();
        splitter = new DeepnoteAutoSplitter();
    });

    suite('splitIfNeeded', () => {
        test('should not split when there is only one non-init notebook', async () => {
            const fs = setupFsMocks();
            const file = createDeepnoteFile([{ id: 'nb-1', name: 'Notebook 1' }]);

            const result = await splitter.splitIfNeeded(Uri.file('/workspace/project.deepnote'), file);

            assert.strictEqual(result.wasSplit, false);
            assert.deepStrictEqual(result.newFiles, []);
            assert.strictEqual(fs.writeCalls.length, 0);
        });

        test('should suffix duplicate notebook names to avoid collisions', async () => {
            const fs = setupFsMocks();
            const file = createDeepnoteFile([
                { id: 'nb-1', name: 'Analysis' },
                { id: 'nb-2', name: 'Analysis' },
                { id: 'nb-3', name: 'Analysis' }
            ]);

            const result = await splitter.splitIfNeeded(Uri.file('/workspace/project.deepnote'), file);

            assert.strictEqual(result.wasSplit, true);
            assert.strictEqual(result.newFiles.length, 2);

            const newFilePaths = result.newFiles.map((uri) => uri.path);
            assert.deepStrictEqual(newFilePaths, [
                '/workspace/project_analysis.deepnote',
                '/workspace/project_analysis_2.deepnote'
            ]);

            // Verify each path was written exactly once and they are unique
            assert.strictEqual(new Set(fs.writeCalls.map((uri) => uri.path)).size, fs.writeCalls.length);
        });

        test('should suffix notebook names that slugify to the same value', async () => {
            const fs = setupFsMocks();
            const file = createDeepnoteFile([
                { id: 'nb-1', name: 'Primary' },
                { id: 'nb-2', name: 'My Notebook' },
                { id: 'nb-3', name: 'my-notebook' }
            ]);

            const result = await splitter.splitIfNeeded(Uri.file('/workspace/project.deepnote'), file);

            assert.strictEqual(result.wasSplit, true);
            assert.strictEqual(result.newFiles.length, 2);

            const newFilePaths = result.newFiles.map((uri) => uri.path);
            assert.deepStrictEqual(newFilePaths, [
                '/workspace/project_my-notebook.deepnote',
                '/workspace/project_my-notebook_2.deepnote'
            ]);

            assert.strictEqual(new Set(fs.writeCalls.map((uri) => uri.path)).size, fs.writeCalls.length);
        });

        test('should suffix fallback-slug collisions when notebook names produce empty slugs', async () => {
            const fs = setupFsMocks();
            const file = createDeepnoteFile([
                { id: 'nb-1', name: 'Primary' },
                { id: 'nb-2', name: '!!!' },
                { id: 'nb-3', name: '???' }
            ]);

            const result = await splitter.splitIfNeeded(Uri.file('/workspace/project.deepnote'), file);

            assert.strictEqual(result.wasSplit, true);
            assert.strictEqual(result.newFiles.length, 2);

            const newFilePaths = result.newFiles.map((uri) => uri.path);
            assert.deepStrictEqual(newFilePaths, [
                '/workspace/project_notebook.deepnote',
                '/workspace/project_notebook_2.deepnote'
            ]);

            assert.strictEqual(new Set(fs.writeCalls.map((uri) => uri.path)).size, fs.writeCalls.length);
        });

        test('should avoid colliding with an existing sibling file on disk', async () => {
            setupFsMocks(['/workspace/project_analysis.deepnote']);
            const file = createDeepnoteFile([
                { id: 'nb-1', name: 'Primary' },
                { id: 'nb-2', name: 'Analysis' }
            ]);

            const result = await splitter.splitIfNeeded(Uri.file('/workspace/project.deepnote'), file);

            assert.strictEqual(result.wasSplit, true);
            assert.strictEqual(result.newFiles.length, 1);
            assert.strictEqual(result.newFiles[0].path, '/workspace/project_analysis_2.deepnote');
        });
    });
});
