import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri, workspace, type NotebookDocument } from 'vscode';

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

function projectFile(notebookId: string, projectId: string = PROJECT_ID): DeepnoteFile {
    return createDeepnoteFile({
        metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
        project: createDeepnoteProject({
            id: projectId,
            name: 'Proj',
            notebooks: [
                createDeepnoteNotebook({
                    id: notebookId,
                    blocks: [createDeepnoteBlock({ id: `${notebookId}-b`, content: notebookId })]
                })
            ]
        })
    });
}

/** Wires workspace.fs/findFiles; `discovered` is decoupled from the active file to model out-of-folder writes. */
function stubWorkspace(opts: {
    onDisk: Array<{ uri: Uri; file: DeepnoteFile }>;
    discovered: Uri[];
    dirtyDocuments?: Array<{ uri: Uri; onSave: (onDisk: Map<string, DeepnoteFile>) => void }>;
    hasWorkspaceFolder?: boolean;
    failWriteFor?: Set<string>;
}): { writes: Map<string, DeepnoteFile> } {
    when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(
        opts.hasWorkspaceFolder === false ? undefined : [createWorkspaceFolder(Uri.file('/ws'))]
    );
    when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve(opts.discovered));

    const byPath = new Map(opts.onDisk.map((entry) => [entry.uri.fsPath, entry.file] as const));
    const writes = new Map<string, DeepnoteFile>();

    // A save() that mutates the on-disk map models a dirty open document being flushed before the re-read.
    const documents = (opts.dirtyDocuments ?? []).map(
        ({ uri, onSave }) =>
            ({
                uri,
                isDirty: true,
                notebookType: 'deepnote',
                save: async () => {
                    onSave(byPath);

                    return true;
                }
            }) as unknown as NotebookDocument
    );

    when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn(documents);
    const mockFs = mock<typeof workspace.fs>();

    when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
        const file = byPath.get(uri.fsPath);

        return file
            ? Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
            : Promise.reject(new Error(`no readFile stub for ${uri.fsPath}`));
    });
    when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
        if (opts.failWriteFor?.has(uri.fsPath)) {
            return Promise.reject(new Error(`write failed for ${uri.fsPath}`));
        }

        writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

        return Promise.resolve();
    });
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

    return { writes };
}

suite('persistProjectIntegrations', () => {
    let managerInstance: IDeepnoteNotebookManager;

    setup(() => {
        resetVSCodeMocks();

        const mockManager = mock<IDeepnoteNotebookManager>();
        when(mockManager.updateProjectIntegrations(anything(), anything())).thenReturn(true);
        managerInstance = instance(mockManager);
    });

    test('writes the active file AND every discovered sibling of the project (disk-driven, not open-state driven)', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling') }
            ],
            discovered: [activeUri, siblingUri]
        });

        const result = await persistProjectIntegrations({
            notebookManager: managerInstance,
            projectId: PROJECT_ID,
            integrations: NEW_INTEGRATIONS,
            activeFileUri: activeUri
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)!.project.integrations, NEW_INTEGRATIONS);
        assert.deepStrictEqual(writes.get(siblingUri.fsPath)!.project.integrations, NEW_INTEGRATIONS);
    });

    test('no workspace folder: still writes the ACTIVE file and reports activePersisted (regression: cache-only success wrote nothing to disk)', async () => {
        const activeUri = Uri.file('/loose/foo.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [{ uri: activeUri, file: projectFile('nb-active') }],
            discovered: [],
            hasWorkspaceFolder: false
        });

        const result = await persistProjectIntegrations({
            notebookManager: managerInstance,
            projectId: PROJECT_ID,
            integrations: NEW_INTEGRATIONS,
            activeFileUri: activeUri
        });

        assert.isTrue(result.activePersisted, 'the active file must be written even with no workspace folder');
        assert.deepStrictEqual(writes.get(activeUri.fsPath)!.project.integrations, NEW_INTEGRATIONS);
    });

    test('active file outside every workspace folder is still written (findFiles never returns it)', async () => {
        const activeUri = Uri.file('/other/foo.deepnote');
        const wsSibling = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: wsSibling, file: projectFile('nb-ws') }
            ],
            discovered: [wsSibling]
        });

        const result = await persistProjectIntegrations({
            notebookManager: managerInstance,
            projectId: PROJECT_ID,
            integrations: NEW_INTEGRATIONS,
            activeFileUri: activeUri
        });

        assert.isTrue(result.activePersisted);
        assert.isTrue(writes.has(activeUri.fsPath), 'the active file outside the folder must be written');
    });

    test('a sibling whose write rejects yields siblingsFailed=1 while activePersisted stays true', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const badSibling = Uri.file('/ws/bad.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: badSibling, file: projectFile('nb-bad') }
            ],
            discovered: [activeUri, badSibling],
            failWriteFor: new Set([badSibling.fsPath])
        });

        const result = await persistProjectIntegrations({
            notebookManager: managerInstance,
            projectId: PROJECT_ID,
            integrations: NEW_INTEGRATIONS,
            activeFileUri: activeUri
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 1 });
        assert.isTrue(writes.has(activeUri.fsPath));
        assert.isFalse(writes.has(badSibling.fsPath));
    });

    test('a failed ACTIVE-file write reports activePersisted=false (regression: no false success)', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [{ uri: activeUri, file: projectFile('nb-active') }],
            discovered: [activeUri],
            failWriteFor: new Set([activeUri.fsPath])
        });

        const result = await persistProjectIntegrations({
            notebookManager: managerInstance,
            projectId: PROJECT_ID,
            integrations: NEW_INTEGRATIONS,
            activeFileUri: activeUri
        });

        assert.isFalse(result.activePersisted, 'a failed active-file write must NOT report success');
        assert.isFalse(writes.has(activeUri.fsPath));
    });

    test('a sibling whose flush swaps its on-disk project is skipped, not written to the wrong project', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling') }
            ],
            discovered: [activeUri, siblingUri],
            // The open document for the sibling is stale: saving it rewrites the file to a DIFFERENT project.
            dirtyDocuments: [
                {
                    uri: siblingUri,
                    onSave: (onDisk) => onDisk.set(siblingUri.fsPath, projectFile('nb-other', 'project-2'))
                }
            ]
        });

        const result = await persistProjectIntegrations({
            notebookManager: managerInstance,
            projectId: PROJECT_ID,
            integrations: NEW_INTEGRATIONS,
            activeFileUri: activeUri
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)!.project.integrations, NEW_INTEGRATIONS);
        assert.isFalse(writes.has(siblingUri.fsPath), 'integrations must NOT be written into the swapped project');
    });
});
