import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri, WorkspaceFolder } from 'vscode';

import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';

import { DeepnoteProjectMetadataPropagator } from './deepnoteProjectMetadataPropagator.node';
import { IDisposableRegistry } from '../common/types';
import { IPlatformDeepnoteNotebookManager } from '../notebooks/deepnote/types';
import type { DeepnoteProject } from './deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('MetadataPropagator', () => {
    let propagator: DeepnoteProjectMetadataPropagator;
    let disposables: IDisposableRegistry;
    let mockManager: IPlatformDeepnoteNotebookManager;

    const PROJECT_ID = 'project-1';
    const OTHER_PROJECT_ID = 'project-2';

    setup(() => {
        resetVSCodeMocks();
        disposables = [];
        mockManager = mock<IPlatformDeepnoteNotebookManager>();
        // Default: nothing cached, so the cache refresh is a no-op unless a test says otherwise.
        when(mockManager.getOriginalProject(anything(), anything())).thenReturn(undefined);

        propagator = new DeepnoteProjectMetadataPropagator(disposables, instance(mockManager));
    });

    teardown(() => {
        for (const d of disposables) {
            d.dispose();
        }
    });

    /** Builds a single-notebook DeepnoteFile for a given project + notebook id. */
    function buildFile(projectId: string, notebookId: string, notebookName = 'Notebook'): DeepnoteFile {
        return {
            metadata: { createdAt: '2025-01-01T00:00:00Z', modifiedAt: '2025-01-01T00:00:00Z' },
            version: '1.0.0',
            project: {
                id: projectId,
                name: 'My Project',
                integrations: [],
                notebooks: [
                    {
                        id: notebookId,
                        name: notebookName,
                        blocks: [
                            {
                                id: `${notebookId}-block-1`,
                                type: 'code',
                                blockGroup: '1',
                                sortingKey: 'a0',
                                metadata: {},
                                content: 'print(1)',
                                outputs: []
                            }
                        ]
                    }
                ]
            }
        } as DeepnoteFile;
    }

    /**
     * Canonical on-disk bytes for a file: what `serializeDeepnoteFile` produces. The propagator
     * reads these verbatim and compares them against its own re-serialization for the no-op skip,
     * so tests must feed the canonical form (not hand-written YAML).
     */
    function canonicalBytes(file: DeepnoteFile): Uint8Array {
        return new TextEncoder().encode(serializeDeepnoteFile(file));
    }

    /**
     * Wires the workspace mock so `findFiles` returns `entries.map(e => e.uri)` and `fs.readFile`
     * returns the canonical bytes for each uri. Returns a `writes` array capturing every
     * `fs.writeFile(uri, content)` call so tests can assert on-disk results, plus an `order` log
     * interleaving `onFileWritten` and `writeFile` events keyed by uri path.
     */
    function setupWorkspace(
        entries: Array<{ uri: Uri; file: DeepnoteFile }>,
        opts: { rejectWriteForPath?: string } = {}
    ): { writes: Array<{ uri: Uri; content: Uint8Array }>; order: string[] } {
        const workspaceFolder: WorkspaceFolder = { uri: Uri.file('/workspace'), name: 'workspace', index: 0 };
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
        when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve(
            entries.map((e) => e.uri) as any
        );

        const byPath = new Map(entries.map((e) => [e.uri.path, e.file]));
        const writes: Array<{ uri: Uri; content: Uint8Array }> = [];
        const order: string[] = [];

        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            const file = byPath.get(uri.path);
            if (!file) {
                return Promise.reject(new Error(`No file for ${uri.path}`));
            }

            return Promise.resolve(canonicalBytes(file));
        });
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, content: Uint8Array) => {
            order.push(`write:${uri.path}`);

            if (opts.rejectWriteForPath && uri.path === opts.rejectWriteForPath) {
                return Promise.reject(new Error('Write failed'));
            }
            writes.push({ uri, content });

            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        return { writes, order };
    }

    function parseWritten(writes: Array<{ uri: Uri; content: Uint8Array }>, uri: Uri): DeepnoteFile {
        const entry = writes.find((w) => w.uri.path === uri.path);
        assert.isDefined(entry, `expected a write for ${uri.path}`);

        return deserializeDeepnoteFile(new TextDecoder().decode(entry!.content));
    }

    test('without on-disk fan-out, a closed sibling keeps stale integrations: both siblings are rewritten and the CLOSED one reflects the change', async () => {
        const openUri = Uri.file('/workspace/open.deepnote');
        const closedUri = Uri.file('/workspace/closed.deepnote');
        const { writes } = setupWorkspace([
            { uri: openUri, file: buildFile(PROJECT_ID, 'nb-open') },
            { uri: closedUri, file: buildFile(PROJECT_ID, 'nb-closed') }
        ]);

        const newIntegrations = [{ id: 'pg-1', name: 'Postgres', type: 'postgres' }];
        const result = await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.integrations = newIntegrations as DeepnoteFile['project']['integrations'];
        });

        // Both uris written.
        assert.strictEqual(writes.length, 2, 'both siblings should be written to disk');
        assert.deepStrictEqual(result.updated.map((u) => u.path).sort(), [closedUri.path, openUri.path].sort());
        assert.deepStrictEqual(result.failures, []);

        // Load-bearing: the CLOSED sibling's on-disk bytes reflect the new integrations.
        const closedWritten = parseWritten(writes, closedUri);
        assert.deepStrictEqual(closedWritten.project.integrations, newIntegrations);
        const openWritten = parseWritten(writes, openUri);
        assert.deepStrictEqual(openWritten.project.integrations, newIntegrations);
    });

    test('a sibling with a non-matching project.id is never written (skips out-of-group files)', async () => {
        const matchUri = Uri.file('/workspace/match.deepnote');
        const otherUri = Uri.file('/workspace/other.deepnote');
        const { writes } = setupWorkspace([
            { uri: matchUri, file: buildFile(PROJECT_ID, 'nb-match') },
            { uri: otherUri, file: buildFile(OTHER_PROJECT_ID, 'nb-other') }
        ]);

        const result = await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.name = 'Renamed';
        });

        assert.strictEqual(writes.length, 1, 'only the matching project file should be written');
        assert.strictEqual(writes[0].uri.path, matchUri.path);
        assert.deepStrictEqual(
            result.updated.map((u) => u.path),
            [matchUri.path]
        );
        // The non-matching file is absent from writes entirely.
        assert.isUndefined(writes.find((w) => w.uri.path === otherUri.path));
    });

    test("a name/integrations mutator leaves each file's single project.notebooks[0] untouched", async () => {
        const uriA = Uri.file('/workspace/a.deepnote');
        const uriB = Uri.file('/workspace/b.deepnote');
        const fileA = buildFile(PROJECT_ID, 'nb-a', 'Notebook A');
        const fileB = buildFile(PROJECT_ID, 'nb-b', 'Notebook B');
        const { writes } = setupWorkspace([
            { uri: uriA, file: fileA },
            { uri: uriB, file: fileB }
        ]);

        await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.name = 'Renamed Project';
            f.project.integrations = [
                { id: 'i', name: 'PG', type: 'postgres' }
            ] as DeepnoteFile['project']['integrations'];
        });

        const writtenA = parseWritten(writes, uriA);
        const writtenB = parseWritten(writes, uriB);

        // Project-level fields changed.
        assert.strictEqual(writtenA.project.name, 'Renamed Project');
        // The single original notebook (id + name) is preserved verbatim per file.
        assert.strictEqual(writtenA.project.notebooks.length, 1);
        assert.deepStrictEqual(
            { id: writtenA.project.notebooks[0].id, name: writtenA.project.notebooks[0].name },
            { id: 'nb-a', name: 'Notebook A' }
        );
        assert.strictEqual(writtenB.project.notebooks.length, 1);
        assert.deepStrictEqual(
            { id: writtenB.project.notebooks[0].id, name: writtenB.project.notebooks[0].name },
            { id: 'nb-b', name: 'Notebook B' }
        );
    });

    test('a mutator that sets a field to its current value is a no-op: no writeFile, no modifiedAt bump, no updated entry', async () => {
        const uri = Uri.file('/workspace/noop.deepnote');
        const file = buildFile(PROJECT_ID, 'nb-1');
        const { writes } = setupWorkspace([{ uri, file }]);

        const result = await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            // Set name to its CURRENT value → serialized bytes are unchanged.
            f.project.name = 'My Project';
        });

        assert.strictEqual(writes.length, 0, 'writeFile must NOT be called for a no-op mutation');
        assert.deepStrictEqual(result.updated, [], 'no file should be reported as updated');
        assert.deepStrictEqual(result.failures, []);
    });

    test('a writeFile rejection for one uri is isolated: the other file is still written, the failure is collected (not thrown), and a summarized warning fires', async () => {
        const goodUri = Uri.file('/workspace/good.deepnote');
        const badUri = Uri.file('/workspace/bad.deepnote');
        const { writes } = setupWorkspace(
            [
                { uri: goodUri, file: buildFile(PROJECT_ID, 'nb-good') },
                { uri: badUri, file: buildFile(PROJECT_ID, 'nb-bad') }
            ],
            { rejectWriteForPath: badUri.path }
        );

        let warned = false;
        when(mockedVSCodeNamespaces.window.showWarningMessage(anything())).thenCall(() => {
            warned = true;

            return Promise.resolve(undefined);
        });

        const result = await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.name = 'Renamed';
        });

        // The good file is still written despite the bad file failing.
        assert.strictEqual(writes.length, 1, 'the non-failing file should still be written');
        assert.strictEqual(writes[0].uri.path, goodUri.path);
        assert.deepStrictEqual(
            result.updated.map((u) => u.path),
            [goodUri.path]
        );
        // The failure is collected, not thrown.
        assert.strictEqual(result.failures.length, 1);
        assert.strictEqual(result.failures[0].uri.path, badUri.path);
        // A single summarized warning is shown.
        assert.isTrue(warned, 'a summarized showWarningMessage should fire on partial failure');
    });

    test('onFileWritten fires synchronously BEFORE the write for that uri (self-write marked before fs.writeFile)', async () => {
        const uri = Uri.file('/workspace/ordered.deepnote');
        const { order } = setupWorkspace([{ uri, file: buildFile(PROJECT_ID, 'nb-1') }]);

        const callbackOrder: string[] = [];
        const disposable = propagator.onFileWritten((u) => {
            callbackOrder.push(`callback:${u.path}`);
            order.push(`callback:${u.path}`);
        });

        await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.name = 'Renamed';
        });
        disposable.dispose();

        // The callback received the uri.
        assert.deepStrictEqual(callbackOrder, [`callback:${uri.path}`]);
        // Ordering: the callback for this uri runs BEFORE its write.
        assert.deepStrictEqual(order, [`callback:${uri.path}`, `write:${uri.path}`]);
    });

    test('cache refresh runs only for cached entries: updateOriginalProject is called for the open sibling and NOT for the closed sibling', async () => {
        const openUri = Uri.file('/workspace/open.deepnote');
        const closedUri = Uri.file('/workspace/closed.deepnote');
        setupWorkspace([
            { uri: openUri, file: buildFile(PROJECT_ID, 'nb-open') },
            { uri: closedUri, file: buildFile(PROJECT_ID, 'nb-closed') }
        ]);

        // The open sibling is cached; the closed one is not.
        when(mockManager.getOriginalProject(PROJECT_ID, 'nb-open')).thenReturn({} as DeepnoteProject);
        when(mockManager.getOriginalProject(PROJECT_ID, 'nb-closed')).thenReturn(undefined);

        const refreshed: Array<{ projectId: string; notebookId: string }> = [];
        when(mockManager.updateOriginalProject(anything(), anything(), anything())).thenCall(
            (projectId: string, notebookId: string) => {
                refreshed.push({ projectId, notebookId });
            }
        );

        await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.name = 'Renamed';
        });

        // Exactly one cache refresh: for the open (cached) sibling only.
        assert.deepStrictEqual(refreshed, [{ projectId: PROJECT_ID, notebookId: 'nb-open' }]);
    });

    test('a *.snapshot.deepnote returned by findFiles is never read or written (snapshot sidecars excluded)', async () => {
        const sourceUri = Uri.file('/workspace/source.deepnote');
        const snapshotUri = Uri.file('/workspace/snapshots/my-project_project-1_latest.snapshot.deepnote');

        const workspaceFolder: WorkspaceFolder = { uri: Uri.file('/workspace'), name: 'workspace', index: 0 };
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
        when(mockedVSCodeNamespaces.workspace.findFiles(anything(), anything(), anything())).thenResolve([
            sourceUri,
            snapshotUri
        ] as any);

        const sourceFile = buildFile(PROJECT_ID, 'nb-1');
        const readPaths: string[] = [];
        const writes: Uri[] = [];
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            readPaths.push(uri.path);

            return Promise.resolve(canonicalBytes(sourceFile));
        });
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri) => {
            writes.push(uri);

            return Promise.resolve();
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        await propagator.propagateProjectMetadata(PROJECT_ID, (f) => {
            f.project.name = 'Renamed';
        });

        // The snapshot file is never read nor written.
        assert.notInclude(readPaths, snapshotUri.path, 'snapshot file must not be read');
        assert.isUndefined(
            writes.find((u) => u.path === snapshotUri.path),
            'snapshot file must not be written'
        );
        // The real source file is processed.
        assert.include(readPaths, sourceUri.path);
        assert.deepStrictEqual(
            writes.map((u) => u.path),
            [sourceUri.path]
        );
    });
});
