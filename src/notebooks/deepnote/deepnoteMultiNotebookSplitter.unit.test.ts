import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { EventEmitter, FileType, NotebookDocument, TabGroups, TabInputNotebook, Uri } from 'vscode';

import { ITelemetryService } from '../../platform/analytics/types';
import type { IDeepnoteNotebookInterpreters } from './deepnoteNotebookInterpreters';
import type { ILogger } from '../../platform/logging/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteMultiNotebookSplitter } from './deepnoteMultiNotebookSplitter';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject
} from './deepnoteTestHelpers';

const SPLIT_ACTION = 'Split into separate files';
const PROMPT_MESSAGE =
    'Multiple notebooks in one .deepnote file is a legacy layout, now being replaced by one file per notebook. Split it?';

const waitTimeoutMs = 4000;
const waitIntervalMs = 10;

async function waitFor(condition: () => boolean, timeoutMs = waitTimeoutMs): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
    }
}

/** A short settle delay used to PROVE that nothing further happened (no write/rename/prompt). */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 80));
}

function basename(uri: Uri): string {
    return uri.path.split('/').pop() ?? '';
}

/**
 * Splitter orchestration (prompt gating, write/rename order, env migration, dirty gate, abort) with
 * the real `allocateSiblingUri` and a mocked `splitByNotebooks`; the original is retired by rename to `.legacy`.
 */
suite('DeepnoteMultiNotebookSplitter', () => {
    let splitter: DeepnoteMultiNotebookSplitter;
    let onDidOpen: EventEmitter<NotebookDocument>;
    let refreshTreeCount: number;

    // Ordered log of side-effecting fs operations, so we can assert write-before-rename ORDER.
    let callLog: Array<{ op: 'write' | 'rename'; name: string }>;
    let writeTargets: string[];
    // Each retire of the original, captured as { from: <original>, to: <legacy> } filenames.
    let renameOps: Array<{ from: string; to: string }>;
    let warnCount: number;
    // Names that the injected `exists` probe reports as already present on disk.
    let existingOnDisk: Set<string>;
    // If set, writing a file with this basename rejects (to test abort-on-failure).
    let failWriteFor: string | undefined;
    // If set, writing this basename creates the file THEN rejects (models a create-then-reject orphan).
    let failWriteAfterCreateFor: string | undefined;
    // Filenames passed to workspace.fs.delete (rollback cleanup), in call order.
    let deleteTargets: string[];
    let mockTelemetryService: ITelemetryService;
    // In-memory stand-in for the pin store, so tests can assert which files ended up pinned.
    let pins: Map<string, string>;
    let notebookInterpreters: IDeepnoteNotebookInterpreters;

    const logger: ILogger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        ci: () => undefined
    } as unknown as ILogger;

    function makeNotebook(id: string, name: string, content: string): DeepnoteFile['project']['notebooks'][number] {
        return createDeepnoteNotebook({ id, name, blocks: [createDeepnoteBlock({ id: `${id}-b`, content })] });
    }

    function makeFile(notebooks: DeepnoteFile['project']['notebooks'], initNotebookId?: string): DeepnoteFile {
        return createDeepnoteFile({
            metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
            project: createDeepnoteProject({
                id: 'project-1',
                name: 'Proj',
                notebooks,
                ...(initNotebookId ? { initNotebookId } : {})
            })
        });
    }

    /** Wire `workspace.fs.readFile` to return the serialized bytes of `file` for any URI. */
    function stubReadFile(file: DeepnoteFile): void {
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenCall(() =>
            Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
        );
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri) => {
            const name = basename(uri);
            if (failWriteAfterCreateFor && name === failWriteAfterCreateFor) {
                existingOnDisk.add(name);
                return Promise.reject(new Error(`write failed after creating ${name}`));
            }
            if (failWriteFor && name === failWriteFor) {
                return Promise.reject(new Error(`write failed for ${name}`));
            }
            callLog.push({ op: 'write', name });
            writeTargets.push(name);
            // A successful write makes the file "exist" for any subsequent allocator probe.
            existingOnDisk.add(name);
            return Promise.resolve();
        });
        when(mockFs.rename(anything(), anything(), anything())).thenCall((source: Uri, target: Uri) => {
            const from = basename(source);
            const to = basename(target);
            callLog.push({ op: 'rename', name: from });
            renameOps.push({ from, to });
            return Promise.resolve();
        });
        when(mockFs.delete(anything(), anything())).thenCall((uri: Uri) => {
            const name = basename(uri);
            deleteTargets.push(name);
            // A rolled-back write frees the name so a retry reuses the base (no `-2`).
            existingOnDisk.delete(name);
            return Promise.resolve();
        });
        when(mockFs.stat(anything())).thenCall((uri: Uri) => {
            if (existingOnDisk.has(basename(uri))) {
                return Promise.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: 0 });
            }
            return Promise.reject(new Error('not found'));
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
    }

    /** Build a NotebookDocument stub for the given file URI. */
    function notebookDoc(
        fileUri: Uri,
        opts?: { isDirty?: boolean; saveResult?: boolean }
    ): NotebookDocument & { readonly _saved: boolean } {
        let saved = false;
        return {
            uri: fileUri,
            notebookType: 'deepnote',
            isDirty: opts?.isDirty ?? false,
            save: () => {
                saved = true;
                return Promise.resolve(opts?.saveResult ?? true);
            },
            get _saved() {
                return saved;
            }
        } as unknown as NotebookDocument & { readonly _saved: boolean };
    }

    function hasTrackedAnEvent(): boolean {
        try {
            verify(mockTelemetryService.trackEvent(anything())).atLeast(1);

            return true;
        } catch {
            return false;
        }
    }

    setup(() => {
        resetVSCodeMocks();
        callLog = [];
        writeTargets = [];
        renameOps = [];
        warnCount = 0;
        refreshTreeCount = 0;
        existingOnDisk = new Set<string>();
        failWriteFor = undefined;
        failWriteAfterCreateFor = undefined;
        deleteTargets = [];
        mockTelemetryService = mock<ITelemetryService>();

        // Re-stub the open-notebook event with our own emitter so tests can fire opens.
        onDidOpen = new EventEmitter<NotebookDocument>();
        when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(onDidOpen.event);

        // Empty tab groups: closeNotebookTab iterates harmlessly (instanceof TabInputNotebook is false anyway).
        when(mockedVSCodeNamespaces.window.tabGroups).thenReturn({ all: [] } as unknown as TabGroups);

        // Count split prompts; default resolves to "dismiss" — individual tests opt into accepting.
        when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).thenCall(() => {
            warnCount++;
            return Promise.resolve(undefined);
        });

        pins = new Map<string, string>();
        notebookInterpreters = {
            get: (uri: Uri) => {
                const pinned = pins.get(uri.toString());

                return pinned ? Uri.parse(pinned) : undefined;
            },
            resolve: () => Promise.resolve(undefined),
            set: async (uri: Uri, interpreter: Uri | undefined) => {
                if (interpreter) {
                    pins.set(uri.toString(), interpreter.toString());
                } else {
                    pins.delete(uri.toString());
                }
            }
        };

        splitter = new DeepnoteMultiNotebookSplitter(
            notebookInterpreters,
            () => {
                refreshTreeCount++;
            },
            logger,
            // `exists` probe injected directly (mirrors deepnoteFileExists, but synchronous-set-backed).
            (uri: Uri) => Promise.resolve(existingOnDisk.has(basename(uri))),
            instance(mockTelemetryService)
        );
        splitter.activate();
    });

    teardown(() => {
        splitter.dispose();
        onDidOpen.dispose();
    });

    /** Make the next (and subsequent) split prompt(s) resolve to the accept action. */
    function acceptSplit(): void {
        when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).thenCall((message: string) => {
            warnCount++;
            if (message === PROMPT_MESSAGE) {
                return Promise.resolve(SPLIT_ACTION);
            }
            return Promise.resolve(undefined);
        });
    }

    /**
     * Build and activate a splitter whose refreshTree throws, plus a private open-event emitter (so
     * the fire below targets exactly this splitter). refreshTree is the last step after the rename,
     * which makes it the injection point for "the split failed once the original was already gone".
     */
    function makeFailingSplitter(): {
        emitter: EventEmitter<NotebookDocument>;
        splitter: DeepnoteMultiNotebookSplitter;
    } {
        const emitter = new EventEmitter<NotebookDocument>();
        when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(emitter.event);

        const failingSplitter = new DeepnoteMultiNotebookSplitter(
            notebookInterpreters,
            () => {
                throw new Error('refresh failed after the rename');
            },
            logger,
            (uri: Uri) => Promise.resolve(existingOnDisk.has(basename(uri))),
            instance(mock<ITelemetryService>())
        );
        failingSplitter.activate();

        return { emitter, splitter: failingSplitter };
    }

    suite('interpreter migration', () => {
        const ORIGINAL = Uri.file('/ws/multi.deepnote');
        const PINNED = Uri.file('/envs/project/bin/python');

        function threeNotebookFile() {
            return makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
        }

        test("carries the original's pinned interpreter onto every child file", async () => {
            stubReadFile(threeNotebookFile());
            pins.set(ORIGINAL.toString(), PINNED.toString());
            acceptSplit();

            onDidOpen.fire(notebookDoc(ORIGINAL));

            await waitFor(() => renameOps.length === 1);
            await settle();

            assert.deepStrictEqual(
                writeTargets.map((name) => pins.get(Uri.file(`/ws/${name}`).toString())),
                [PINNED.toString(), PINNED.toString(), PINNED.toString()],
                'each child must run on the interpreter the original was pinned to'
            );
        });

        test("clears the retired original's pin, so the dead URI does not keep one", async () => {
            stubReadFile(threeNotebookFile());
            pins.set(ORIGINAL.toString(), PINNED.toString());
            acceptSplit();

            onDidOpen.fire(notebookDoc(ORIGINAL));

            await waitFor(() => renameOps.length === 1);
            await settle();

            assert.isUndefined(pins.get(ORIGINAL.toString()));
        });

        test('a split that fails after the rename leaves the pins exactly as it found them', async () => {
            stubReadFile(threeNotebookFile());
            const { emitter, splitter: failingSplitter } = makeFailingSplitter();
            pins.set(ORIGINAL.toString(), PINNED.toString());
            acceptSplit();

            try {
                emitter.fire(notebookDoc(ORIGINAL));

                await waitFor(() => deleteTargets.length > 0);
                await settle();

                assert.deepStrictEqual(
                    [...pins.entries()],
                    [[ORIGINAL.toString(), PINNED.toString()]],
                    "rollback must restore the original pin and drop the children's"
                );
            } finally {
                failingSplitter.dispose();
                emitter.dispose();
            }
        });

        test('an unpinned file splits without inventing a pin for the children', async () => {
            stubReadFile(threeNotebookFile());
            acceptSplit();

            onDidOpen.fire(notebookDoc(ORIGINAL));

            await waitFor(() => renameOps.length === 1);
            await settle();

            assert.strictEqual(pins.size, 0, 'nothing was pinned, so nothing should be');
        });
    });

    suite('prompt gating', () => {
        test('a 3-notebook file prompts and writes/renames NOTHING until the action is taken (regression: no silent rewrite on open)', async () => {
            const file = makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
            stubReadFile(file);
            // Default prompt resolves to dismiss.

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));

            await waitFor(() => warnCount >= 1);
            await settle();

            assert.strictEqual(warnCount, 1, 'should prompt exactly once');
            assert.strictEqual(writeTargets.length, 0, 'no writeFile until the split action is taken');
            assert.strictEqual(renameOps.length, 0, 'no rename until the split action is taken');
        });

        test('a single-notebook file does NOT prompt (regression: a valid file must not be flagged)', async () => {
            const file = makeFile([makeNotebook('only', 'Solo', 's')]);
            stubReadFile(file);

            onDidOpen.fire(notebookDoc(Uri.file('/ws/solo.deepnote')));

            await settle();

            assert.strictEqual(warnCount, 0, 'single-notebook file must not prompt');
        });

        test('a standalone init file (one notebook, id === initNotebookId) does NOT prompt (regression: init file is a valid single-notebook file)', async () => {
            const file = makeFile([makeNotebook('init-1', 'Init', 'setup')], 'init-1');
            stubReadFile(file);

            onDidOpen.fire(notebookDoc(Uri.file('/ws/init.deepnote')));

            await settle();

            assert.strictEqual(warnCount, 0, 'standalone init file (length 1) must not prompt');
        });

        test('prompts at most once per file per session (regression: re-open must not re-prompt)', async () => {
            const file = makeFile([makeNotebook('n1', 'A', 'a'), makeNotebook('n2', 'B', 'b')]);
            stubReadFile(file);
            const uri = Uri.file('/ws/dup.deepnote');

            onDidOpen.fire(notebookDoc(uri));
            await waitFor(() => warnCount >= 1);

            // Fire the open again for the SAME file.
            onDidOpen.fire(notebookDoc(uri));
            await settle();

            assert.strictEqual(warnCount, 1, 'a file must be prompted at most once per session');
        });
    });

    suite('split action', () => {
        test('writes N new files then retires the original — the rename happens AFTER the last write (ORDER, load-bearing)', async () => {
            const file = makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
            stubReadFile(file);
            acceptSplit();

            const originalUri = Uri.file('/ws/multi.deepnote');
            onDidOpen.fire(notebookDoc(originalUri));

            await waitFor(() => renameOps.length >= 1);

            // N = 3 writes, exactly one rename.
            assert.strictEqual(writeTargets.length, 3, 'should write one new file per notebook (N=3)');
            assert.strictEqual(renameOps.length, 1, 'should retire the original exactly once');

            // The convert mock names files {stem}-{slug}.deepnote.
            assert.deepStrictEqual(writeTargets, [
                'multi-alpha.deepnote',
                'multi-beta.deepnote',
                'multi-gamma.deepnote'
            ]);

            // ORDER: every write must come before the single rename in the call log.
            const renameIndex = callLog.findIndex((c) => c.op === 'rename');
            const lastWriteIndex = callLog.map((c) => c.op).lastIndexOf('write');
            assert.isAbove(renameIndex, lastWriteIndex, 'the rename must happen AFTER the last write');
            assert.strictEqual(
                callLog.filter((c) => c.op === 'write').length,
                3,
                'all three writes must precede the rename'
            );

            // The retired file is the original, renamed to its `.legacy` sibling.
            assert.strictEqual(renameOps[0].from, 'multi.deepnote', 'the retired file must be the original');
            assert.strictEqual(renameOps[0].to, 'multi.deepnote.legacy', 'the original must be renamed to .legacy');
        });

        test('retires the original by renaming it to <name>.deepnote.legacy, never deleting it (regression: keep a restorable backup)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            let renameTarget: string | undefined;
            let renameOptions: { overwrite?: boolean } | undefined;
            let deleteCalled = false;
            when(mockFs.readFile(anything())).thenCall(() =>
                Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
            );
            when(mockFs.writeFile(anything(), anything())).thenResolve();
            when(mockFs.stat(anything())).thenReject(new Error('not found'));
            when(mockFs.rename(anything(), anything(), anything())).thenCall(
                (source: Uri, target: Uri, opts: { overwrite?: boolean }) => {
                    renameTarget = basename(target);
                    renameOptions = opts;
                    renameOps.push({ from: basename(source), to: basename(target) });
                    return Promise.resolve();
                }
            );
            when(mockFs.delete(anything(), anything())).thenCall(() => {
                deleteCalled = true;
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
            acceptSplit();

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(() => renameOps.length >= 1);

            assert.strictEqual(
                renameTarget,
                'multi.deepnote.legacy',
                'the original must be renamed to <name>.deepnote.legacy'
            );
            assert.deepStrictEqual(
                renameOptions,
                { overwrite: false },
                'the rename must not overwrite an existing backup'
            );
            assert.isFalse(deleteCalled, 'the original must be renamed, never deleted');
        });

        test('bumps the legacy name to .legacy-2 when <name>.deepnote.legacy already exists (regression: never clobber a prior backup)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            // A previous split already left a backup on disk.
            existingOnDisk.add('multi.deepnote.legacy');

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(() => renameOps.length >= 1);

            assert.strictEqual(renameOps[0].from, 'multi.deepnote', 'the original is the rename source');
            assert.strictEqual(
                renameOps[0].to,
                'multi.deepnote.legacy-2',
                'a taken .legacy name must be bumped to .legacy-2'
            );
        });

        test('refreshes the tree after a successful split', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(() => refreshTreeCount >= 1);

            assert.strictEqual(refreshTreeCount, 1, 'tree should refresh once after split');
        });
    });

    suite('abort-before-retire on write failure (load-bearing safety)', () => {
        test('if a child writeFile rejects, the original is NEVER renamed and an error is surfaced (original left intact)', async () => {
            const file = makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
            stubReadFile(file);
            acceptSplit();

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            // The SECOND child write fails.
            failWriteFor = 'multi-beta.deepnote';

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));

            await waitFor(() => errorShown);
            await settle();

            assert.strictEqual(renameOps.length, 0, 'the original must NEVER be renamed when a child write fails');
            // The first write succeeded before the failure; the original is still present (never retired).
            assert.isTrue(errorShown, 'an error must be surfaced on write failure');
            assert.deepStrictEqual(writeTargets, ['multi-alpha.deepnote'], 'only writes before the failure occurred');
        });

        test('a child write that CREATES the file then rejects is cleaned up (regression: no untracked orphan → no -2 duplicate on retry)', async () => {
            const file = makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
            stubReadFile(file);
            acceptSplit();

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            // The second child write creates the destination, then rejects mid-write (partial orphan).
            failWriteAfterCreateFor = 'multi-beta.deepnote';

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));

            await waitFor(() => errorShown);
            await settle();

            assert.strictEqual(renameOps.length, 0, 'the original must NEVER be renamed when a child write fails');
            assert.include(deleteTargets, 'multi-beta.deepnote', 'the partial orphan must be deleted on rollback');
            assert.isFalse(
                existingOnDisk.has('multi-beta.deepnote'),
                'the orphan must not remain on disk after rollback'
            );
        });

        test('aborts BEFORE renaming when the original tab could not be closed (regression: never rename out from under an open editor)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            // The original's editor tab is still open and its close is cancelled (resolves false).
            const originalUri = Uri.file('/ws/multi.deepnote');
            let closeAttempted = false;
            when(mockedVSCodeNamespaces.window.tabGroups).thenReturn({
                all: [{ tabs: [{ input: new TabInputNotebook(originalUri, 'deepnote') }] }],
                close: () => {
                    closeAttempted = true;
                    return Promise.resolve(false);
                }
            } as unknown as TabGroups);

            onDidOpen.fire(notebookDoc(originalUri));

            await waitFor(() => errorShown);
            await settle();

            assert.isTrue(closeAttempted, 'a close must have been attempted');
            assert.strictEqual(renameOps.length, 0, 'must NOT rename the original when its tab could not be closed');
            assert.include(deleteTargets, 'multi-alpha.deepnote', 'already-written siblings must be rolled back');
            assert.include(deleteTargets, 'multi-beta.deepnote', 'already-written siblings must be rolled back');
        });
    });

    suite('rollback on late failure (compensating cleanup)', () => {
        /** Capture the exact message passed to window.showErrorMessage. */
        function captureErrorMessage(): { get: () => string | undefined } {
            let message: string | undefined;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall((msg: string) => {
                message = msg;
                return Promise.resolve(undefined);
            });

            return { get: () => message };
        }

        test('a failure after the rename rolls the original back into place and reports it restored', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();
            const errors = captureErrorMessage();

            // The rename succeeds, then the post-rename refresh fails.
            const { emitter, splitter: failingSplitter } = makeFailingSplitter();

            emitter.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));

            await waitFor(() => errors.get() !== undefined);
            await settle();

            // The forward rename happened, and the rollback renamed the original back.
            assert.deepStrictEqual(renameOps, [
                { from: 'multi.deepnote', to: 'multi.deepnote.legacy' },
                { from: 'multi.deepnote.legacy', to: 'multi.deepnote' }
            ]);
            assert.deepStrictEqual(
                deleteTargets.slice().sort(),
                ['multi-alpha.deepnote', 'multi-beta.deepnote'],
                'the new siblings are still cleaned up'
            );
            assert.strictEqual(
                errors.get(),
                'Failed to split file: refresh failed after the rename. The original file was restored.'
            );

            failingSplitter.dispose();
            emitter.dispose();
        });
    });

    suite('dirty gate (load-bearing safety)', () => {
        test('a dirty document is saved first before the split proceeds', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            const uri = Uri.file('/ws/multi.deepnote');
            const doc = notebookDoc(uri, { isDirty: true, saveResult: true });
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([doc]);

            onDidOpen.fire(doc);

            await waitFor(() => renameOps.length >= 1);

            assert.isTrue(doc._saved, 'document.save() must be called for a dirty doc');
            assert.strictEqual(writeTargets.length, 2, 'split proceeds after a successful save');
        });

        test('if save() returns false (declined), the split ABORTS — no writeFile, no rename (regression: must not lose unsaved edits)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve(undefined);
            });

            const uri = Uri.file('/ws/multi.deepnote');
            const doc = notebookDoc(uri, { isDirty: true, saveResult: false });
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([doc]);

            onDidOpen.fire(doc);

            await waitFor(() => errorShown);
            await settle();

            assert.strictEqual(writeTargets.length, 0, 'declined save must abort before any write');
            assert.strictEqual(renameOps.length, 0, 'declined save must abort before any rename');
        });
    });

    suite('collision safety', () => {
        test('an allocated name already on disk is bumped to -2 (the existing path is NOT a write target)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            // `multi-alpha.deepnote` already exists on disk (e.g. a previous split / user file).
            existingOnDisk.add('multi-alpha.deepnote');

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(() => renameOps.length >= 1);

            assert.deepStrictEqual(
                writeTargets,
                ['multi-alpha-2.deepnote', 'multi-beta.deepnote'],
                'the colliding name must be bumped to -2 and the existing file must not be a write target'
            );
            assert.notInclude(writeTargets, 'multi-alpha.deepnote', 'must NOT overwrite the pre-existing file');
        });

        test('the ORIGINAL file URI is never a write target (regression: never rewrite the open document in place)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(() => renameOps.length >= 1);

            assert.notInclude(writeTargets, 'multi.deepnote', 'the original file must never be written');
        });
    });

    suite('telemetry outcomes', () => {
        test('a dismissed prompt reports split_notebook cancelled with the parsed notebook count', async () => {
            const file = makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
            stubReadFile(file);
            // Default prompt resolves to dismiss.

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(hasTrackedAnEvent);

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'split_notebook',
                        properties: { notebookCount: 3, outcome: 'cancelled' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('a successful split reports split_notebook completed with the number of files created', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(hasTrackedAnEvent);

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'split_notebook',
                        properties: { notebookCount: 2, outcome: 'completed' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('a failed split (child write rejects, rollback) reports split_notebook failed with the parsed notebook count', async () => {
            const file = makeFile([
                makeNotebook('n1', 'Alpha', 'a'),
                makeNotebook('n2', 'Beta', 'b'),
                makeNotebook('n3', 'Gamma', 'c')
            ]);
            stubReadFile(file);
            acceptSplit();
            failWriteFor = 'multi-beta.deepnote';

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(hasTrackedAnEvent);

            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'split_notebook',
                        properties: { notebookCount: 3, outcome: 'failed' }
                    })
                )
            ).once();
            verify(mockTelemetryService.trackEvent(anything())).once();
        });

        test('a split that yields no files leaves the original in place and reports failed', async () => {
            // Both notebooks are the init notebook, so splitByNotebooks yields nothing and retiring
            // the original would strand the user with no replacement file.
            const file = makeFile(
                [makeNotebook('init-1', 'Init', 'a'), makeNotebook('init-1', 'Also Init', 'b')],
                'init-1'
            );
            stubReadFile(file);
            acceptSplit();

            onDidOpen.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));
            await waitFor(hasTrackedAnEvent);

            assert.strictEqual(writeTargets.length, 0, 'must not write any child file');
            assert.strictEqual(
                renameOps.length,
                0,
                'the original must NEVER be retired when no children were produced'
            );
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).atLeast(1);
            verify(
                mockTelemetryService.trackEvent(
                    deepEqual({
                        eventName: 'split_notebook',
                        properties: { notebookCount: 2, outcome: 'failed' }
                    })
                )
            ).once();
        });
    });

    suite('init shape', () => {
        test('a legacy [init, main] file splits into an init file + a main file that still references initNotebookId', async () => {
            const file = makeFile(
                [makeNotebook('init-1', 'Init', 'setup'), makeNotebook('main-1', 'Main', 'work')],
                'init-1'
            );

            // Capture the parsed file written for each target so we can inspect notebook ids / initNotebookId.
            const writtenFiles: Array<{ name: string; parsed: DeepnoteFile }> = [];
            const mockFs = mock<typeof import('vscode').workspace.fs>();
            when(mockFs.readFile(anything())).thenCall(() =>
                Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
            );
            when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri, bytes: Uint8Array) => {
                // serializeDeepnoteFile emits YAML — parse it back with the real deserializer.
                writtenFiles.push({
                    name: basename(uri),
                    parsed: deserializeDeepnoteFile(new TextDecoder().decode(bytes))
                });
                writeTargets.push(basename(uri));
                return Promise.resolve();
            });
            when(mockFs.stat(anything())).thenReject(new Error('not found'));
            when(mockFs.rename(anything(), anything(), anything())).thenCall((source: Uri, target: Uri) => {
                renameOps.push({ from: basename(source), to: basename(target) });
                return Promise.resolve();
            });
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
            acceptSplit();

            onDidOpen.fire(notebookDoc(Uri.file('/ws/legacy.deepnote')));
            await waitFor(() => renameOps.length >= 1);

            // The mock splitByNotebooks emits the init notebook FIRST.
            assert.strictEqual(writtenFiles.length, 2, 'two files written for [init, main]');

            const initFile = writtenFiles.find((w) => w.parsed.project.notebooks[0].id === 'init-1');
            const mainFile = writtenFiles.find((w) => w.parsed.project.notebooks[0].id === 'main-1');

            assert.isDefined(initFile, 'an init file (containing the init notebook) must be written');
            assert.isDefined(mainFile, 'a main file (containing the main notebook) must be written');
            assert.strictEqual(
                initFile!.parsed.project.notebooks.length,
                1,
                'the init notebook lives in its own single-notebook file'
            );
            assert.strictEqual(
                mainFile!.parsed.project.initNotebookId,
                'init-1',
                'the main file must still reference the init notebook via initNotebookId'
            );
        });
    });
});
