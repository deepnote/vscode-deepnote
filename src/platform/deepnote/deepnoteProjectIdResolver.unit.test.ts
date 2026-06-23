import { assert } from 'chai';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { NotebookDocument, Uri } from 'vscode';

import { serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';

import { resolveProjectIdForFile, resolveProjectIdForNotebook } from './deepnoteProjectIdResolver';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('DeepnoteProjectIdResolver', () => {
    setup(() => {
        resetVSCodeMocks();
    });

    function createDeepnoteFile(projectId = 'project-on-disk'): DeepnoteFile {
        return {
            metadata: {
                createdAt: '2023-01-01T00:00:00Z',
                modifiedAt: '2023-01-02T00:00:00Z'
            },
            project: {
                id: projectId,
                name: 'Disk Project',
                notebooks: [
                    {
                        id: 'notebook-1',
                        name: 'Notebook One',
                        blocks: []
                    }
                ],
                settings: {}
            },
            version: '1.0.0'
        };
    }

    /**
     * Stubs `workspace.fs.readFile`. Returns the underlying mock so callers can
     * assert which URI it was asked to read (proving metadata short-circuits the read).
     */
    function stubReadFile(value: string | Error): typeof import('vscode').workspace.fs {
        const mockFs = mock<typeof import('vscode').workspace.fs>();

        if (value instanceof Error) {
            when(mockFs.readFile(anything())).thenReject(value);
        } else {
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(value) as never);
        }

        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        return mockFs;
    }

    function createNotebook(uri: Uri, metadata?: Record<string, unknown>): NotebookDocument {
        return {
            uri,
            metadata: metadata ?? {}
        } as unknown as NotebookDocument;
    }

    suite('resolveProjectIdForFile', () => {
        test("returns the file's project.id", async () => {
            stubReadFile(serializeDeepnoteFile(createDeepnoteFile('the-project-id')));

            const result = await resolveProjectIdForFile(Uri.file('/workspace/project.deepnote'));

            assert.strictEqual(result, 'the-project-id');
        });

        test('returns undefined (does not throw) on a read failure', async () => {
            stubReadFile(new Error('ENOENT'));

            const result = await resolveProjectIdForFile(Uri.file('/workspace/missing.deepnote'));

            assert.strictEqual(result, undefined);
        });

        test('returns undefined (does not throw) on a parse failure', async () => {
            stubReadFile('not: valid: yaml: [');

            const result = await resolveProjectIdForFile(Uri.file('/workspace/garbage.deepnote'));

            assert.strictEqual(result, undefined);
        });
    });

    suite('resolveProjectIdForNotebook', () => {
        test('returns notebook.metadata.deepnoteProjectId WITHOUT reading the file', async () => {
            const mockFs = stubReadFile(new Error('readFile must not be called'));
            const notebook = createNotebook(Uri.file('/workspace/project.deepnote'), {
                deepnoteProjectId: 'metadata-project-id'
            });

            const result = await resolveProjectIdForNotebook(notebook);

            assert.strictEqual(result, 'metadata-project-id');
            // The metadata short-circuit means the (rejecting) file read is never attempted.
            verify(mockFs.readFile(anything())).never();
        });

        test('falls back to reading the file when metadata is absent', async () => {
            stubReadFile(serializeDeepnoteFile(createDeepnoteFile('file-fallback-id')));
            const notebook = createNotebook(Uri.file('/workspace/project.deepnote'), {});

            const result = await resolveProjectIdForNotebook(notebook);

            assert.strictEqual(result, 'file-fallback-id');
        });

        test('strips query + fragment from the notebook URI before reading the file', async () => {
            const mockFs = stubReadFile(serializeDeepnoteFile(createDeepnoteFile('stripped-id')));
            const notebook = createNotebook(
                Uri.file('/workspace/project.deepnote').with({ query: 'notebook=abc', fragment: 'cell0' }),
                {}
            );

            const result = await resolveProjectIdForNotebook(notebook);

            assert.strictEqual(result, 'stripped-id');

            const [readUri] = capture(mockFs.readFile).last();
            assert.strictEqual((readUri as Uri).query, '');
            assert.strictEqual((readUri as Uri).fragment, '');
            assert.strictEqual((readUri as Uri).path, '/workspace/project.deepnote');
        });

        test('returns undefined (does not throw) when the fallback file read fails', async () => {
            stubReadFile(new Error('ENOENT'));
            const notebook = createNotebook(Uri.file('/workspace/missing.deepnote'), {});

            const result = await resolveProjectIdForNotebook(notebook);

            assert.strictEqual(result, undefined);
        });
    });
});
