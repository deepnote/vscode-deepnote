import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { Uri } from 'vscode';

import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { buildSiblingNotebookFileUri, buildSingleNotebookFile, getFileStem } from './deepnoteNotebookFileFactory';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject
} from './deepnoteTestHelpers';

/**
 * The "new notebook" / "duplicate notebook" flows build a sibling FILE (never an extra notebook
 * appended into one file). Uses the REAL `@deepnote/blocks` serializer for the round-trip assertion.
 */
suite('DeepnoteNotebookFileFactory', () => {
    function makeNotebook(id: string, name: string): DeepnoteNotebook {
        return createDeepnoteNotebook({
            id,
            name,
            blocks: [createDeepnoteBlock({ id: `${id}-block`, blockGroup: 'g1', content: 'print(1)' })]
        });
    }

    function makeSource(overrides?: Partial<DeepnoteFile['metadata']>): DeepnoteFile {
        return createDeepnoteFile({
            metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z', ...overrides },
            project: createDeepnoteProject({
                id: 'project-1',
                name: 'My Project',
                initNotebookId: 'init-notebook',
                integrations: [{ id: 'int-1', name: 'My Postgres', type: 'postgres' }],
                settings: { requirements: ['pandas'] },
                notebooks: [makeNotebook('nb-1', 'First')]
            })
        });
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
        const neverExists = () => Promise.resolve(false);

        test('produces {projectSlug}-{notebookSlug}.deepnote next to the source (regression: match snapshot slug convention)', async () => {
            const uri = await buildSiblingNotebookFileUri(
                Uri.file('/workspace/project/report.deepnote'),
                'My Project',
                'My Notebook',
                neverExists
            );

            assert.deepStrictEqual(uri, Uri.file('/workspace/project/my-project-my-notebook.deepnote'));
        });

        test('derives the stem from the project name, IGNORING the source filename (regression: filename must not compound with other notebooks)', async () => {
            // Even when the source is a split sibling `marketing-overview.deepnote`, the new file is named
            // from the project ("Marketing") → `marketing-extra.deepnote`, NOT `marketing-overview-extra`.
            const uri = await buildSiblingNotebookFileUri(
                Uri.file('/workspace/project/marketing-overview.deepnote'),
                'Marketing',
                'Extra',
                neverExists
            );

            assert.deepStrictEqual(uri, Uri.file('/workspace/project/marketing-extra.deepnote'));
        });

        test('bumps -2 via the shared allocator on collision (regression: must not clobber an existing sibling)', async () => {
            const existsFirst = (uri: Uri) =>
                Promise.resolve((uri.path.split('/').pop() ?? '') === 'my-project-my-notebook.deepnote');
            const uri2 = await buildSiblingNotebookFileUri(
                Uri.file('/workspace/project/report.deepnote'),
                'My Project',
                'My Notebook',
                existsFirst
            );
            assert.deepStrictEqual(uri2, Uri.file('/workspace/project/my-project-my-notebook-2.deepnote'));
        });

        test('falls back to a constant slug for a blank project or notebook name (regression: no leading/trailing dash-only stem)', async () => {
            const original = Uri.file('/workspace/project/report.deepnote');

            const blankNotebook = await buildSiblingNotebookFileUri(original, 'My Project', '   ', neverExists);
            assert.deepStrictEqual(blankNotebook, Uri.file('/workspace/project/my-project-notebook.deepnote'));

            const blankProject = await buildSiblingNotebookFileUri(original, '   ', 'My Notebook', neverExists);
            assert.deepStrictEqual(blankProject, Uri.file('/workspace/project/project-my-notebook.deepnote'));
        });
    });
});
