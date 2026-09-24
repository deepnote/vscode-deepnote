import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri, workspace, type NotebookDocument } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { ProjectIntegration, RawProjectIntegration } from '../../types';
import { DeepnoteNotebookManager } from '../deepnoteNotebookManager';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject,
    createMockNotebook,
    createWorkspaceFolder
} from '../deepnoteTestHelpers';
import { addProjectIntegration, removeProjectIntegration } from './projectIntegrationsWriter';

const PROJECT_ID = 'project-1';

function projectFile(
    notebookId: string,
    projectId: string = PROJECT_ID,
    integrations: RawProjectIntegration[] = []
): DeepnoteFile {
    return createDeepnoteFile({
        metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
        project: createDeepnoteProject({
            id: projectId,
            integrations,
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

/** A notebook open from `uri`; an `onSave` makes it dirty, and mutating the on-disk map models its save. */
interface OpenNotebook {
    notebookId: string;
    onSave?: (onDisk: Map<string, DeepnoteFile>) => void;
    uri: Uri;
}

/** Wires workspace.fs/findFiles; `discovered` is decoupled from the active file to model out-of-folder writes. */
function stubWorkspace(opts: {
    onDisk: Array<{ uri: Uri; file: DeepnoteFile }>;
    discovered: Uri[];
    openNotebooks?: OpenNotebook[];
    hasWorkspaceFolder?: boolean;
    failWriteFor?: Set<string>;
    onWrite?: (uri: Uri) => void;
}): { writes: Map<string, DeepnoteFile> } {
    when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(
        opts.hasWorkspaceFolder === false ? undefined : [createWorkspaceFolder(Uri.file('/ws'))]
    );
    when(mockedVSCodeNamespaces.workspace.findFiles(anything())).thenReturn(Promise.resolve(opts.discovered));

    const byPath = new Map(opts.onDisk.map((entry) => [entry.uri.fsPath, entry.file] as const));
    const writes = new Map<string, DeepnoteFile>();

    const documents = (opts.openNotebooks ?? []).map(({ notebookId, onSave, uri }): NotebookDocument => {
        const notebook = createMockNotebook({
            metadata: { deepnoteNotebookId: notebookId, deepnoteProjectId: PROJECT_ID },
            uri
        });

        return onSave
            ? {
                  ...notebook,
                  isDirty: true,
                  save: async () => {
                      onSave(byPath);

                      return true;
                  }
              }
            : notebook;
    });

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

        opts.onWrite?.(uri);
        writes.set(uri.fsPath, deserializeDeepnoteFile(new TextDecoder().decode(bytes)));

        return Promise.resolve();
    });
    when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

    return { writes };
}

suite('addProjectIntegration', () => {
    const ADDED: ProjectIntegration = { id: 'int-added', name: 'Added Postgres', type: 'pgsql' };

    let managerInstance: DeepnoteNotebookManager;

    setup(() => {
        resetVSCodeMocks();

        managerInstance = new DeepnoteNotebookManager();
    });

    function cachedIntegrations(notebookId: string): RawProjectIntegration[] | undefined {
        return managerInstance.getProjectForNotebook(PROJECT_ID, notebookId)?.project.integrations;
    }

    test('merges into each file rather than stamping one roster over them all', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const ownEntry: ProjectIntegration = { id: 'int-own', name: 'Own BigQuery', type: 'big-query' };
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling', PROJECT_ID, [ownEntry]) }
            ],
            discovered: [activeUri, siblingUri]
        });

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [ADDED]);
        assert.deepStrictEqual(
            writes.get(siblingUri.fsPath)?.project.integrations,
            [ownEntry, ADDED],
            "the sibling's own entry survives an add driven from another file"
        );
    });

    test('replaces an id the file already declares instead of duplicating it', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                {
                    uri: activeUri,
                    file: projectFile('nb-active', PROJECT_ID, [{ ...ADDED, name: 'Stale name' }])
                }
            ],
            discovered: [activeUri]
        });

        await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [ADDED]);
    });

    test('keeps a replaced entry where it was', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const before: ProjectIntegration = { id: 'int-before', name: 'Before', type: 'mysql' };
        const after: ProjectIntegration = { id: 'int-after', name: 'After', type: 'mysql' };
        const { writes } = stubWorkspace({
            onDisk: [
                {
                    uri: activeUri,
                    file: projectFile('nb-active', PROJECT_ID, [before, { ...ADDED, name: 'Stale name' }, after])
                }
            ],
            discovered: [activeUri]
        });

        await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [before, ADDED, after]);
    });

    test('writes the active file even with no workspace folder open', async () => {
        const activeUri = Uri.file('/loose/foo.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [{ uri: activeUri, file: projectFile('nb-active') }],
            discovered: [],
            hasWorkspaceFolder: false
        });

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [ADDED]);
    });

    test('writes an active file outside every workspace folder, which discovery never returns', async () => {
        const activeUri = Uri.file('/other/foo.deepnote');
        const wsSibling = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: wsSibling, file: projectFile('nb-ws') }
            ],
            discovered: [wsSibling]
        });

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [ADDED]);
        assert.deepStrictEqual(writes.get(wsSibling.fsPath)?.project.integrations, [ADDED]);
    });

    test('counts a sibling whose write fails, while the active file still lands', async () => {
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

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 1 });
        assert.isTrue(writes.has(activeUri.fsPath));
        assert.isFalse(writes.has(badSibling.fsPath));
    });

    test('skips a sibling whose flush swaps its on-disk project for another one', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling') }
            ],
            discovered: [activeUri, siblingUri],
            // The open document for the sibling is stale: saving it rewrites the file to a DIFFERENT project.
            openNotebooks: [
                {
                    notebookId: 'nb-sibling',
                    onSave: (onDisk) => onDisk.set(siblingUri.fsPath, projectFile('nb-other', 'project-2')),
                    uri: siblingUri
                }
            ]
        });

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, [ADDED]);
        assert.isFalse(writes.has(siblingUri.fsPath), 'the integration must not be written into the other project');
    });

    test('writes nothing and leaves the cache untouched when the active file cannot be written', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling') }
            ],
            discovered: [activeUri, siblingUri],
            failWriteFor: new Set([activeUri.fsPath]),
            openNotebooks: [
                { notebookId: 'nb-active', uri: activeUri },
                { notebookId: 'nb-sibling', uri: siblingUri }
            ]
        });
        managerInstance.storeOriginalProject(PROJECT_ID, 'nb-active', projectFile('nb-active'));
        managerInstance.storeOriginalProject(PROJECT_ID, 'nb-sibling', projectFile('nb-sibling'));

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: false, siblingsFailed: 0 });
        assert.strictEqual(writes.size, 0, 'the add reaches no file once the one the user acted in refused it');
        assert.deepStrictEqual(
            cachedIntegrations('nb-active'),
            [],
            'nothing reaches the cache that did not reach the disk'
        );
        assert.deepStrictEqual(cachedIntegrations('nb-sibling'), []);
    });

    test('sweeps no sibling when the active file is skipped rather than written', async () => {
        // A snapshot records a past run, so its own write is skipped; sweeping from one stamps the integration
        // across the project's real files on behalf of a file that never took it.
        const snapshotUri = Uri.file('/ws/snapshots/proj_project-1_latest.snapshot.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [{ uri: siblingUri, file: projectFile('nb-sibling') }],
            discovered: [siblingUri],
            openNotebooks: [{ notebookId: 'nb-sibling', uri: siblingUri }]
        });
        managerInstance.storeOriginalProject(PROJECT_ID, 'nb-sibling', projectFile('nb-sibling'));

        const result = await addProjectIntegration({
            activeFileUri: snapshotUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: false, siblingsFailed: 0 });
        assert.strictEqual(writes.size, 0, 'the project files stay as they are');
        assert.deepStrictEqual(cachedIntegrations('nb-sibling'), []);
    });

    test('moves the cache before sweeping siblings, so a save mid-sweep cannot revert the add', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        // Saving a notebook rebuilds its file from the cached project, so anything written while the cache still
        // holds the old list gets undone. Ordering is the only thing keeping that window shut.
        let activeCacheAtSiblingWrite: RawProjectIntegration[] | undefined;
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling') }
            ],
            discovered: [activeUri, siblingUri],
            onWrite: (uri) => {
                if (uri.fsPath === siblingUri.fsPath) {
                    activeCacheAtSiblingWrite = cachedIntegrations('nb-active');
                }
            },
            openNotebooks: [{ notebookId: 'nb-active', uri: activeUri }]
        });
        managerInstance.storeOriginalProject(PROJECT_ID, 'nb-active', projectFile('nb-active'));

        await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(activeCacheAtSiblingWrite, [ADDED]);
        assert.deepStrictEqual(writes.get(siblingUri.fsPath)?.project.integrations, [ADDED]);
    });

    test("moves each open notebook's cache to what its own file now declares", async () => {
        // Catches: every cached notebook of the project stamped with the active file's list, which a later save of
        // a sibling then writes over the entries only that sibling declares.
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const ownEntry: ProjectIntegration = { id: 'int-own', name: 'Own BigQuery', type: 'big-query' };
        const siblingEntry: ProjectIntegration = { id: 'int-sibling', name: 'Sibling MySQL', type: 'mysql' };
        stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active', PROJECT_ID, [ownEntry]) },
                { uri: siblingUri, file: projectFile('nb-sibling', PROJECT_ID, [siblingEntry]) }
            ],
            discovered: [activeUri, siblingUri],
            openNotebooks: [
                { notebookId: 'nb-active', uri: activeUri },
                { notebookId: 'nb-sibling', uri: siblingUri }
            ]
        });
        managerInstance.storeOriginalProject(PROJECT_ID, 'nb-active', projectFile('nb-active', PROJECT_ID, [ownEntry]));
        managerInstance.storeOriginalProject(
            PROJECT_ID,
            'nb-sibling',
            projectFile('nb-sibling', PROJECT_ID, [siblingEntry])
        );

        await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(cachedIntegrations('nb-active'), [ownEntry, ADDED]);
        assert.deepStrictEqual(cachedIntegrations('nb-sibling'), [siblingEntry, ADDED]);
    });

    test("keeps the entries only a dirty sibling declares when the sweep's flush saves it", async () => {
        // Catches: the sibling's cache stamped with the active file's list before the sweep reaches it, so the flush
        // that saves its unsaved edits writes that list over the sibling's own entries before the merge re-reads it.
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const siblingEntry: ProjectIntegration = { id: 'int-sibling', name: 'Sibling MySQL', type: 'mysql' };
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active') },
                { uri: siblingUri, file: projectFile('nb-sibling', PROJECT_ID, [siblingEntry]) }
            ],
            discovered: [activeUri, siblingUri],
            openNotebooks: [
                { notebookId: 'nb-active', uri: activeUri },
                {
                    notebookId: 'nb-sibling',
                    // Like the serializer: a save writes the whole file from the notebook's cache entry.
                    onSave: (onDisk) => {
                        const cached = managerInstance.getProjectForNotebook(PROJECT_ID, 'nb-sibling');

                        if (cached) {
                            onDisk.set(siblingUri.fsPath, cached);
                        }
                    },
                    uri: siblingUri
                }
            ]
        });
        managerInstance.storeOriginalProject(PROJECT_ID, 'nb-active', projectFile('nb-active'));
        managerInstance.storeOriginalProject(
            PROJECT_ID,
            'nb-sibling',
            projectFile('nb-sibling', PROJECT_ID, [siblingEntry])
        );

        const result = await addProjectIntegration({
            activeFileUri: activeUri,
            integration: ADDED,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(siblingUri.fsPath)?.project.integrations, [siblingEntry, ADDED]);
        assert.deepStrictEqual(cachedIntegrations('nb-sibling'), [siblingEntry, ADDED]);
    });
});

suite('removeProjectIntegration', () => {
    const REMOVED: ProjectIntegration = { id: 'int-removed', name: 'Removed Postgres', type: 'pgsql' };
    const KEPT: RawProjectIntegration[] = [
        { id: 'int-kept', name: 'Kept BigQuery', type: 'big-query' },
        { id: 'duckdb', name: 'DuckDB', type: 'pandas-dataframe' }
    ];

    let managerInstance: DeepnoteNotebookManager;

    setup(() => {
        resetVSCodeMocks();

        managerInstance = new DeepnoteNotebookManager();
    });

    test("takes the id off the active file and every sibling, keeping each file's other entries and its cache in step", async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const siblingEntry: ProjectIntegration = { id: 'int-sibling', name: 'Sibling MySQL', type: 'mysql' };
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active', PROJECT_ID, [...KEPT, REMOVED]) },
                { uri: siblingUri, file: projectFile('nb-sibling', PROJECT_ID, [REMOVED, siblingEntry]) }
            ],
            discovered: [activeUri, siblingUri],
            openNotebooks: [
                { notebookId: 'nb-active', uri: activeUri },
                { notebookId: 'nb-sibling', uri: siblingUri }
            ]
        });
        managerInstance.storeOriginalProject(
            PROJECT_ID,
            'nb-active',
            projectFile('nb-active', PROJECT_ID, [...KEPT, REMOVED])
        );
        managerInstance.storeOriginalProject(
            PROJECT_ID,
            'nb-sibling',
            projectFile('nb-sibling', PROJECT_ID, [REMOVED, siblingEntry])
        );

        const result = await removeProjectIntegration({
            activeFileUri: activeUri,
            integrationId: REMOVED.id,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: true, siblingsFailed: 0 });
        assert.deepStrictEqual(writes.get(activeUri.fsPath)?.project.integrations, KEPT);
        assert.deepStrictEqual(writes.get(siblingUri.fsPath)?.project.integrations, [siblingEntry]);
        assert.deepStrictEqual(
            managerInstance.getProjectForNotebook(PROJECT_ID, 'nb-active')?.project.integrations,
            KEPT
        );
        assert.deepStrictEqual(managerInstance.getProjectForNotebook(PROJECT_ID, 'nb-sibling')?.project.integrations, [
            siblingEntry
        ]);
    });

    test('sweeps no sibling when the active file cannot be written', async () => {
        const activeUri = Uri.file('/ws/active.deepnote');
        const siblingUri = Uri.file('/ws/sibling.deepnote');
        const { writes } = stubWorkspace({
            onDisk: [
                { uri: activeUri, file: projectFile('nb-active', PROJECT_ID, [REMOVED]) },
                { uri: siblingUri, file: projectFile('nb-sibling', PROJECT_ID, [REMOVED]) }
            ],
            discovered: [activeUri, siblingUri],
            failWriteFor: new Set([activeUri.fsPath])
        });

        const result = await removeProjectIntegration({
            activeFileUri: activeUri,
            integrationId: REMOVED.id,
            notebookManager: managerInstance,
            projectId: PROJECT_ID
        });

        assert.deepStrictEqual(result, { activePersisted: false, siblingsFailed: 0 });
        assert.strictEqual(writes.size, 0, 'the removal reaches no file once the one the user acted in refused it');
    });
});
