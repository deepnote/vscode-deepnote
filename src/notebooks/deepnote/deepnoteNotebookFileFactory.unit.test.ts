import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { Uri } from 'vscode';

import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { buildSiblingNotebookFileUri, buildSingleNotebookFile, getFileStem } from './deepnoteNotebookFileFactory';

/**
 * The "new notebook" / "duplicate notebook" flows build a sibling FILE (never an extra notebook
 * appended into one file). Uses the REAL `@deepnote/blocks` serializer for the round-trip assertion.
 */
suite('DeepnoteNotebookFileFactory', () => {
    function makeNotebook(id: string, name: string): DeepnoteNotebook {
        return {
            id,
            name,
            blocks: [
                {
                    id: `${id}-block`,
                    type: 'code',
                    sortingKey: 'a0',
                    blockGroup: 'g1',
                    content: 'print(1)'
                }
            ]
        } as unknown as DeepnoteNotebook;
    }

    function makeSource(overrides?: Partial<DeepnoteFile['metadata']>): DeepnoteFile {
        return {
            version: '1.0.0',
            metadata: {
                createdAt: '2020-01-01T00:00:00Z',
                modifiedAt: '2021-01-01T00:00:00Z',
                ...overrides
            },
            project: {
                id: 'project-1',
                name: 'My Project',
                initNotebookId: 'init-notebook',
                integrations: [{ id: 'int-1', name: 'My Postgres', type: 'postgres' }],
                settings: { requirements: ['pandas'] },
                notebooks: [makeNotebook('nb-1', 'First')]
            }
        } as unknown as DeepnoteFile;
    }

    suite('getFileStem', () => {
        test('returns basename up to the FIRST dot (regression: a.b.deepnote must collapse to a)', () => {
            assert.strictEqual(getFileStem(Uri.file('/x/report.deepnote')), 'report');
            assert.strictEqual(getFileStem(Uri.file('/x/a.b.deepnote')), 'a');
        });
    });

    suite('buildSingleNotebookFile', () => {
        test('carries initNotebookId forward and sets exactly one notebook (regression: must not drop init pointer or keep siblings)', () => {
            const source = makeSource();
            const newNotebook = makeNotebook('nb-2', 'Second');

            const built = buildSingleNotebookFile(source, newNotebook);

            assert.strictEqual(built.project.initNotebookId, 'init-notebook', 'initNotebookId must carry forward');
            assert.strictEqual(built.project.notebooks.length, 1, 'built file must contain exactly one notebook');
            assert.deepStrictEqual(
                built.project.notebooks[0],
                newNotebook,
                'the one notebook must be the provided one'
            );
            assert.strictEqual(built.version, '1.0.0', 'top-level version must be preserved');
        });

        test('stamps a fresh modifiedAt but preserves the source createdAt (regression: createdAt must not be reset)', () => {
            const source = makeSource();
            const before = Date.now();

            const built = buildSingleNotebookFile(source, makeNotebook('nb-2', 'Second'));

            assert.strictEqual(built.metadata.createdAt, '2020-01-01T00:00:00Z', 'createdAt must be preserved');
            assert.notStrictEqual(built.metadata.modifiedAt, '2021-01-01T00:00:00Z', 'modifiedAt must be refreshed');
            const stampedMs = Date.parse(built.metadata.modifiedAt as string);
            assert.isAtLeast(stampedMs, before, 'modifiedAt must be a fresh timestamp');
        });

        test('synthesizes a createdAt when the source has no metadata (regression: missing metadata must not crash)', () => {
            const source = makeSource();
            delete (source as { metadata?: unknown }).metadata;

            const built = buildSingleNotebookFile(source, makeNotebook('nb-2', 'Second'));

            assert.isString(built.metadata.createdAt, 'a createdAt must be synthesized when absent');
            assert.isString(built.metadata.modifiedAt, 'a modifiedAt must be stamped when absent');
        });

        test('built file has no metadata.snapshotHash after a serialize -> deserialize round-trip (schema-stripped)', () => {
            const source = makeSource();

            const built = buildSingleNotebookFile(source, makeNotebook('nb-2', 'Second'));
            const roundTripped = deserializeDeepnoteFile(serializeDeepnoteFile(built));

            assert.notProperty(
                roundTripped.metadata ?? {},
                'snapshotHash',
                'snapshotHash must be absent after a serialize/deserialize round-trip'
            );
            // The init pointer and project metadata must survive the round-trip too.
            assert.strictEqual(roundTripped.project.initNotebookId, 'init-notebook');
            assert.strictEqual(roundTripped.project.notebooks.length, 1);
        });
    });

    suite('buildSiblingNotebookFileUri', () => {
        const original = Uri.file('/workspace/project/report.deepnote');
        const neverExists = () => Promise.resolve(false);

        test('produces {stem}-{slug}.deepnote (regression: must match convert split naming)', async () => {
            const uri = await buildSiblingNotebookFileUri(original, 'My Notebook', neverExists);

            assert.deepStrictEqual(uri, Uri.file('/workspace/project/report-my-notebook.deepnote'));
        });

        test('bumps -2 via the shared allocator on collision (regression: must not clobber an existing sibling)', async () => {
            const existsFirst = (uri: Uri) =>
                Promise.resolve((uri.path.split('/').pop() ?? '') === 'report-my-notebook.deepnote');
            const uri2 = await buildSiblingNotebookFileUri(original, 'My Notebook', existsFirst);
            assert.deepStrictEqual(uri2, Uri.file('/workspace/project/report-my-notebook-2.deepnote'));
        });

        test('falls back to {stem}-notebook.deepnote for an empty/blank notebook name (regression: blank slug must not yield {stem}-.deepnote)', async () => {
            const emptyName = await buildSiblingNotebookFileUri(original, '', neverExists);
            assert.deepStrictEqual(emptyName, Uri.file('/workspace/project/report-notebook.deepnote'));

            const blankName = await buildSiblingNotebookFileUri(original, '   ', neverExists);
            assert.deepStrictEqual(blankName, Uri.file('/workspace/project/report-notebook.deepnote'));
        });
    });
});
