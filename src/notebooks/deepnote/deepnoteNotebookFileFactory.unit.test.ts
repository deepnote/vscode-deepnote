import { type DeepnoteFile } from '@deepnote/blocks';
import { assert, expect } from 'chai';
import { Uri } from 'vscode';

import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import {
    buildSiblingNotebookFileUri,
    buildSingleNotebookFile,
    computeSnapshotHash,
    getFileStem,
    slugifyNotebookNameOrFallback
} from './deepnoteNotebookFileFactory';

function createNotebook(id: string, name: string, blockId = `block-${id}`, contentHash?: string): DeepnoteNotebook {
    return {
        blocks: [
            {
                blockGroup: `bg-${id}`,
                content: '',
                contentHash,
                id: blockId,
                metadata: {},
                sortingKey: '0',
                type: 'code',
                version: 1
            }
        ],
        executionMode: 'block',
        id,
        name
    };
}

function createSourceFile(overrides?: Partial<DeepnoteFile['project']>): DeepnoteFile {
    return {
        metadata: {
            createdAt: '2024-01-01T00:00:00.000Z',
            modifiedAt: '2024-01-01T00:00:00.000Z'
        },
        project: {
            id: 'project-1',
            name: 'Source Project',
            notebooks: [createNotebook('nb-1', 'First Notebook', 'block-nb-1', 'hash-a')],
            ...overrides
        },
        version: '1.0.0'
    };
}

suite('deepnoteNotebookFileFactory', () => {
    suite('buildSingleNotebookFile', () => {
        test('should preserve project id/name/version and set metadata.modifiedAt while preserving createdAt', async () => {
            const source = createSourceFile();
            const notebook = createNotebook('nb-new', 'My New Notebook', 'block-nb-new', 'hash-b');

            const result = await buildSingleNotebookFile(source, notebook);

            assert.strictEqual(result.project.id, 'project-1');
            assert.strictEqual(result.project.name, 'Source Project');
            assert.strictEqual(result.version, '1.0.0');
            assert.strictEqual(result.metadata?.createdAt, '2024-01-01T00:00:00.000Z');
            assert.isString(result.metadata?.modifiedAt);
            // modifiedAt should be freshly set (not the frozen source value)
            assert.notStrictEqual(result.metadata?.modifiedAt, '2024-01-01T00:00:00.000Z');
        });

        test('should compute snapshotHash metadata', async () => {
            const source = createSourceFile();
            const notebook = createNotebook('nb-new', 'My New Notebook', 'block-nb-new', 'hash-b');

            const result = await buildSingleNotebookFile(source, notebook);
            const snapshotHash = (result.metadata as Record<string, unknown>).snapshotHash;

            assert.isString(snapshotHash);
            expect(snapshotHash as string).to.match(/^sha256:/);
        });

        test('should include init notebook clone when initNotebookId is set', async () => {
            const initNotebook = createNotebook('init-nb', 'Init Notebook', 'block-init', 'hash-init');
            const source = createSourceFile({
                initNotebookId: 'init-nb',
                notebooks: [initNotebook, createNotebook('nb-1', 'First Notebook', 'block-nb-1', 'hash-a')]
            });
            const newNotebook = createNotebook('nb-new', 'My New Notebook', 'block-nb-new', 'hash-b');

            const result = await buildSingleNotebookFile(source, newNotebook);

            assert.strictEqual(result.project.notebooks.length, 2);
            assert.strictEqual(result.project.notebooks[0].id, 'init-nb');
            assert.strictEqual(result.project.notebooks[0].name, 'Init Notebook');
            assert.strictEqual(result.project.notebooks[1].id, 'nb-new');
            assert.strictEqual(result.project.initNotebookId, 'init-nb');

            // Init notebook should be a clone (different reference) but same content
            assert.notStrictEqual(result.project.notebooks[0], initNotebook);
        });

        test('should not include init notebook when initNotebookId is not set', async () => {
            const source = createSourceFile();
            const newNotebook = createNotebook('nb-new', 'My New Notebook', 'block-nb-new', 'hash-b');

            const result = await buildSingleNotebookFile(source, newNotebook);

            assert.strictEqual(result.project.notebooks.length, 1);
            assert.strictEqual(result.project.notebooks[0].id, 'nb-new');
            assert.isUndefined(result.project.initNotebookId);
        });

        test('should not include init notebook when initNotebookId is set but init notebook is missing', async () => {
            const source = createSourceFile({
                initNotebookId: 'missing-init-id'
            });
            const newNotebook = createNotebook('nb-new', 'My New Notebook', 'block-nb-new', 'hash-b');

            const result = await buildSingleNotebookFile(source, newNotebook);

            assert.strictEqual(result.project.notebooks.length, 1);
            assert.strictEqual(result.project.notebooks[0].id, 'nb-new');
            assert.isUndefined(result.project.initNotebookId);
        });
    });

    suite('buildSiblingNotebookFileUri', () => {
        test('should return ${stem}_${slug}.deepnote when the path does not exist', async () => {
            const sourceUri = Uri.file('/workspace/test-project.deepnote');
            const exists = async (_u: Uri) => false;

            const result = await buildSiblingNotebookFileUri(sourceUri, 'My Notebook', exists);

            assert.strictEqual(result.path, '/workspace/test-project_my-notebook.deepnote');
        });

        test('should append _2 on first collision', async () => {
            const sourceUri = Uri.file('/workspace/test-project.deepnote');
            const exists = async (u: Uri) => u.path === '/workspace/test-project_my-notebook.deepnote';

            const result = await buildSiblingNotebookFileUri(sourceUri, 'My Notebook', exists);

            assert.strictEqual(result.path, '/workspace/test-project_my-notebook_2.deepnote');
        });

        test('should keep incrementing suffix on repeated collisions', async () => {
            const sourceUri = Uri.file('/workspace/test-project.deepnote');
            const taken = new Set([
                '/workspace/test-project_my-notebook.deepnote',
                '/workspace/test-project_my-notebook_2.deepnote',
                '/workspace/test-project_my-notebook_3.deepnote'
            ]);
            const exists = async (u: Uri) => taken.has(u.path);

            const result = await buildSiblingNotebookFileUri(sourceUri, 'My Notebook', exists);

            assert.strictEqual(result.path, '/workspace/test-project_my-notebook_4.deepnote');
        });

        test("should use 'notebook' fallback slug for names that slugify to empty", async () => {
            const sourceUri = Uri.file('/workspace/test-project.deepnote');
            const exists = async (_u: Uri) => false;

            const result = await buildSiblingNotebookFileUri(sourceUri, '!!!', exists);

            assert.strictEqual(result.path, '/workspace/test-project_notebook.deepnote');
        });
    });

    suite('slugifyNotebookNameOrFallback', () => {
        test("should return 'my-notebook' for 'My Notebook'", () => {
            assert.strictEqual(slugifyNotebookNameOrFallback('My Notebook'), 'my-notebook');
        });

        test("should return 'notebook' for '!!!' (unslugifiable name)", () => {
            assert.strictEqual(slugifyNotebookNameOrFallback('!!!'), 'notebook');
        });

        test("should return 'notebook' for empty name", () => {
            assert.strictEqual(slugifyNotebookNameOrFallback(''), 'notebook');
        });
    });

    suite('getFileStem', () => {
        test("should return 'test-project' for /a/b/test-project.deepnote", () => {
            const uri = Uri.file('/a/b/test-project.deepnote');

            assert.strictEqual(getFileStem(uri), 'test-project');
        });

        test("should return 'file' for /a/b/file (no dot)", () => {
            const uri = Uri.file('/a/b/file');

            assert.strictEqual(getFileStem(uri), 'file');
        });

        test('should stop at the first dot for multi-dot filenames', () => {
            const uri = Uri.file('/a/b/my.snapshot.deepnote');

            assert.strictEqual(getFileStem(uri), 'my');
        });
    });

    suite('computeSnapshotHash', () => {
        test('should be deterministic - same input twice returns same hash', async () => {
            const file = createSourceFile();

            const hashA = await computeSnapshotHash(file);
            const hashB = await computeSnapshotHash(file);

            assert.strictEqual(hashA, hashB);
            expect(hashA).to.match(/^sha256:/);
        });

        test("should change when a block's contentHash changes", async () => {
            const fileA = createSourceFile();
            const fileB = createSourceFile({
                notebooks: [createNotebook('nb-1', 'First Notebook', 'block-nb-1', 'hash-CHANGED')]
            });

            const hashA = await computeSnapshotHash(fileA);
            const hashB = await computeSnapshotHash(fileB);

            assert.notStrictEqual(hashA, hashB);
        });

        test('should be insensitive to block order (hashes are sorted internally)', async () => {
            const fileA: DeepnoteFile = {
                metadata: { createdAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: 'p',
                    name: 'p',
                    notebooks: [
                        {
                            blocks: [
                                {
                                    blockGroup: 'bg',
                                    content: '',
                                    contentHash: 'h-a',
                                    id: 'b1',
                                    metadata: {},
                                    sortingKey: '0',
                                    type: 'code',
                                    version: 1
                                },
                                {
                                    blockGroup: 'bg',
                                    content: '',
                                    contentHash: 'h-b',
                                    id: 'b2',
                                    metadata: {},
                                    sortingKey: '1',
                                    type: 'code',
                                    version: 1
                                }
                            ],
                            executionMode: 'block',
                            id: 'nb',
                            name: 'nb'
                        }
                    ]
                },
                version: '1.0.0'
            };
            const fileB: DeepnoteFile = {
                metadata: { createdAt: '2024-01-01T00:00:00.000Z' },
                project: {
                    id: 'p',
                    name: 'p',
                    notebooks: [
                        {
                            blocks: [
                                {
                                    blockGroup: 'bg',
                                    content: '',
                                    contentHash: 'h-b',
                                    id: 'b2',
                                    metadata: {},
                                    sortingKey: '1',
                                    type: 'code',
                                    version: 1
                                },
                                {
                                    blockGroup: 'bg',
                                    content: '',
                                    contentHash: 'h-a',
                                    id: 'b1',
                                    metadata: {},
                                    sortingKey: '0',
                                    type: 'code',
                                    version: 1
                                }
                            ],
                            executionMode: 'block',
                            id: 'nb',
                            name: 'nb'
                        }
                    ]
                },
                version: '1.0.0'
            };

            const hashA = await computeSnapshotHash(fileA);
            const hashB = await computeSnapshotHash(fileB);

            assert.strictEqual(hashA, hashB);
        });
    });
});
