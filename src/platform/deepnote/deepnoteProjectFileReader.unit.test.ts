import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';

import { readDeepnoteProjectFile } from './deepnoteProjectFileReader';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('DeepnoteProjectFileReader', () => {
    setup(() => {
        resetVSCodeMocks();
    });

    function createDeepnoteFile(): DeepnoteFile {
        return {
            metadata: {
                createdAt: '2023-01-01T00:00:00Z',
                modifiedAt: '2023-01-02T00:00:00Z'
            },
            project: {
                id: 'project-round-trip',
                name: 'Round Trip Project',
                notebooks: [
                    {
                        id: 'notebook-1',
                        name: 'Notebook One',
                        blocks: [
                            {
                                blockGroup: 'group-1',
                                id: 'block-1',
                                content: 'print("hello")',
                                sortingKey: 'a0',
                                metadata: {},
                                type: 'code'
                            }
                        ]
                    }
                ],
                settings: {}
            },
            version: '1.0.0'
        };
    }

    function stubReadFile(value: string | Error): void {
        const mockFs = mock<typeof import('vscode').workspace.fs>();

        if (value instanceof Error) {
            when(mockFs.readFile(anything())).thenReject(value);
        } else {
            when(mockFs.readFile(anything())).thenResolve(new TextEncoder().encode(value) as never);
        }

        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
    }

    test('round-trips a valid .deepnote buffer to a DeepnoteFile', async () => {
        const original = createDeepnoteFile();

        stubReadFile(serializeDeepnoteFile(original));

        const result = await readDeepnoteProjectFile(Uri.file('/workspace/project.deepnote'));

        assert.strictEqual(result.project.id, original.project.id);
        assert.strictEqual(result.project.name, original.project.name);
        assert.strictEqual(result.project.notebooks.length, 1);
        assert.strictEqual(result.project.notebooks[0].id, 'notebook-1');
        assert.strictEqual(result.project.notebooks[0].name, 'Notebook One');
        assert.strictEqual(result.version, '1.0.0');
    });

    test('rejects (propagates the parse error) on a schema-invalid buffer', async () => {
        // A YAML-valid but schema-invalid document (missing the required `metadata`/`project`).
        stubReadFile('version: 1.0');

        let threw = false;
        try {
            await readDeepnoteProjectFile(Uri.file('/workspace/bad.deepnote'));
        } catch {
            threw = true;
        }

        assert.isTrue(threw, 'readDeepnoteProjectFile should surface (not swallow) a malformed buffer');
    });

    test('rejects on a non-YAML / garbage buffer', async () => {
        stubReadFile('not: valid: yaml: [');

        let threw = false;
        try {
            await readDeepnoteProjectFile(Uri.file('/workspace/garbage.deepnote'));
        } catch {
            threw = true;
        }

        assert.isTrue(threw, 'readDeepnoteProjectFile should surface a non-parseable buffer');
    });
});
