import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri, workspace } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject,
    createWorkspaceFolder
} from '../deepnoteTestHelpers';
import { persistProjectIntegrations } from './projectIntegrationsWriter';

const PROJECT_ID = 'project-1';

const NEW_INTEGRATIONS: ProjectIntegration[] = [{ id: 'int-new', name: 'New BigQuery', type: 'big-query' }];

/**
 * Wires `workspace.workspaceFolders`, `findFiles`, and `workspace.fs` so `persistProjectIntegrations`
 * discovers exactly `files` on disk. `readFile` is dispatched by URI path; every `writeFile` is parsed
 * back into the returned `writes` map (keyed by fsPath) so a test can assert what landed on disk.
 */
function stubWorkspace(files: Array<{ uri: Uri; file: DeepnoteFile }>): { writes: Map<string, DeepnoteFile> } {
    when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([createWorkspaceFolder(Uri.file('/ws'))]);
    when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(
        Promise.resolve(files.map((entry) => entry.uri))
    );

    const byPath = new Map<string, DeepnoteFile>();

    for (const entry of files) {
        byPath.set(entry.uri.fsPath, entry.file);
    }

    const writes = new Map<string, DeepnoteFile>();
    const mockFs = mock<typeof workspace.fs>();

    when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
        const file = byPath.get(uri.fsPath);

        if (!file) {
            return Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`));
        }

        return Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)));
    });
    when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
        writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

        return Promise.resolve();
    });
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

    return { writes };
}

suite('persistProjectIntegrations', () => {
    let mockManager: IDeepnoteNotebookManager;
    let managerInstance: IDeepnoteNotebookManager;

    setup(() => {
        resetVSCodeMocks();

        mockManager = mock<IDeepnoteNotebookManager>();
        when(mockManager.updateProjectIntegrations(anything(), anything())).thenReturn(true);
        managerInstance = instance(mockManager);
    });

    test('writes the new integrations into BOTH an open and a closed sibling of the project (disk-driven, not open-state driven)', async () => {
        // The two siblings share one project.id; the helper is disk-driven, so an OPEN sibling (its
        // cache entry refreshed) and a CLOSED one (cache-only path used to miss it) get identical writes.
        const openUri = Uri.file('/ws/open.deepnote');
        const closedUri = Uri.file('/ws/closed.deepnote');
        const { writes } = stubWorkspace([
            {
                uri: openUri,
                file: createDeepnoteFile({
                    metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
                    project: createDeepnoteProject({
                        id: PROJECT_ID,
                        name: 'Proj',
                        notebooks: [
                            createDeepnoteNotebook({
                                id: 'nb-open',
                                blocks: [createDeepnoteBlock({ id: 'nb-open-b', content: 'open' })]
                            })
                        ]
                    })
                })
            },
            {
                uri: closedUri,
                file: createDeepnoteFile({
                    metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
                    project: createDeepnoteProject({
                        id: PROJECT_ID,
                        name: 'Proj',
                        notebooks: [
                            createDeepnoteNotebook({
                                id: 'nb-closed',
                                blocks: [createDeepnoteBlock({ id: 'nb-closed-b', content: 'closed' })]
                            })
                        ]
                    })
                })
            }
        ]);

        const result = await persistProjectIntegrations(managerInstance, PROJECT_ID, NEW_INTEGRATIONS);

        assert.isTrue(result, 'should report success when files were written');
        assert.isTrue(writes.has(openUri.fsPath), 'the open sibling must be written');
        assert.isTrue(writes.has(closedUri.fsPath), 'the closed sibling must be written');
        assert.deepStrictEqual(writes.get(openUri.fsPath)!.project.integrations, NEW_INTEGRATIONS);
        assert.deepStrictEqual(writes.get(closedUri.fsPath)!.project.integrations, NEW_INTEGRATIONS);
    });
});
