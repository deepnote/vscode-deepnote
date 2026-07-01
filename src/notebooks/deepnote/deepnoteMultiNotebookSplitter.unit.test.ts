import { deserializeDeepnoteFile, serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, NotebookDocument, Uri } from 'vscode';

import type { IDeepnoteNotebookEnvironmentMapper } from '../../kernels/deepnote/types';
import type { ILogger } from '../../platform/logging/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteMultiNotebookSplitter } from './deepnoteMultiNotebookSplitter';

const SPLIT_ACTION = 'Split into separate files';
const PROMPT_MESSAGE = 'This .deepnote file contains multiple notebooks. Split it into one file per notebook?';

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
 * Tests for the on-demand multi-notebook splitter (§2). These exercise the splitter's
 * ORCHESTRATION (prompt gating, write/rename ORDER, env migration, dirty gate, abort-on-failure)
 * plus the REAL local `allocateSiblingUri`, against the MOCKED `@deepnote/convert` `splitByNotebooks`.
 *
 * The original file is retired by RENAMING it to `<name>.deepnote.legacy` (not deleted): the suffix
 * takes it out of the extension's view while keeping it on disk to restore.
 *
 * NOTE: `instanceof TabInputNotebook` is always false against the test class-proxy, so the
 * tab-close path is NOT unit-exercisable and is intentionally not asserted (see harness notes).
 */
suite('DeepnoteMultiNotebookSplitter', () => {
    let splitter: DeepnoteMultiNotebookSplitter;
    let onDidOpen: EventEmitter<NotebookDocument>;
    let refreshTreeCount: number;
    let envMapper: IDeepnoteNotebookEnvironmentMapper;

    // Ordered log of side-effecting fs operations, so we can assert write-before-rename ORDER.
    let callLog: Array<{ op: 'write' | 'rename'; name: string }>;
    let writeTargets: string[];
    // Each retire of the original, captured as { from: <original>, to: <legacy> } basenames.
    let renameOps: Array<{ from: string; to: string }>;
    let warnCount: number;
    // Names that the injected `exists` probe reports as already present on disk.
    let existingOnDisk: Set<string>;
    // If set, writing a file with this basename rejects (to test abort-on-failure).
    let failWriteFor: string | undefined;

    const logger: ILogger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        ci: () => undefined
    } as unknown as ILogger;

    function makeNotebook(id: string, name: string, content: string): DeepnoteFile['project']['notebooks'][number] {
        return {
            id,
            name,
            blocks: [{ id: `${id}-b`, type: 'code', sortingKey: 'a0', blockGroup: 'g', content }]
        } as unknown as DeepnoteFile['project']['notebooks'][number];
    }

    function makeFile(notebooks: DeepnoteFile['project']['notebooks'], initNotebookId?: string): DeepnoteFile {
        return {
            version: '1.0.0',
            metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
            project: {
                id: 'project-1',
                name: 'Proj',
                ...(initNotebookId ? { initNotebookId } : {}),
                notebooks
            }
        } as unknown as DeepnoteFile;
    }

    /** Wire `workspace.fs.readFile` to return the serialized bytes of `file` for any URI. */
    function stubReadFile(file: DeepnoteFile): void {
        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readFile(anything())).thenCall(() =>
            Promise.resolve(new TextEncoder().encode(serializeDeepnoteFile(file)))
        );
        when(mockFs.writeFile(anything(), anything())).thenCall((uri: Uri) => {
            const name = basename(uri);
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
        when(mockFs.stat(anything())).thenCall((uri: Uri) => {
            if (existingOnDisk.has(basename(uri))) {
                return Promise.resolve({} as never);
            }
            return Promise.reject(new Error('not found'));
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));
    }

    /** Build a NotebookDocument stub for the given file URI. */
    function notebookDoc(fileUri: Uri, opts?: { isDirty?: boolean; saveResult?: boolean }): NotebookDocument {
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
        } as unknown as NotebookDocument;
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

        // Re-stub the open-notebook event with our own emitter so tests can fire opens.
        onDidOpen = new EventEmitter<NotebookDocument>();
        when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(onDidOpen.event);

        // Empty tab groups: closeNotebookTab iterates harmlessly (instanceof TabInputNotebook is false anyway).
        when(mockedVSCodeNamespaces.window.tabGroups).thenReturn({ all: [] } as never);

        // Count split prompts; default resolves to "dismiss" — individual tests opt into accepting.
        when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).thenCall(() => {
            warnCount++;
            return Promise.resolve(undefined);
        });

        // Environment mapper: per-notebook env, recorded via real-ish maps.
        const envMock = mock<IDeepnoteNotebookEnvironmentMapper>();
        when(envMock.getEnvironmentForNotebook(anything())).thenReturn(undefined);
        when(envMock.setEnvironmentForNotebook(anything(), anything())).thenResolve();
        when(envMock.removeEnvironmentForNotebook(anything())).thenResolve();
        envMapper = instance(envMock);

        splitter = new DeepnoteMultiNotebookSplitter(
            envMapper,
            () => {
                refreshTreeCount++;
            },
            logger,
            // `exists` probe injected directly (mirrors deepnoteFileExists, but synchronous-set-backed).
            (uri: Uri) => Promise.resolve(existingOnDisk.has(basename(uri)))
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

        test('copies the original env mapping onto each new file and removes the original mapping (regression: split-time env migration)', async () => {
            const file = makeFile([makeNotebook('n1', 'Alpha', 'a'), makeNotebook('n2', 'Beta', 'b')]);
            stubReadFile(file);
            acceptSplit();

            const setCalls: string[] = [];
            const removeCalls: string[] = [];
            const envMock = mock<IDeepnoteNotebookEnvironmentMapper>();
            when(envMock.getEnvironmentForNotebook(anything())).thenReturn('env-xyz');
            when(envMock.setEnvironmentForNotebook(anything(), anything())).thenCall((uri: Uri, env: string) => {
                setCalls.push(`${basename(uri)}=${env}`);
                return Promise.resolve();
            });
            when(envMock.removeEnvironmentForNotebook(anything())).thenCall((uri: Uri) => {
                removeCalls.push(basename(uri));
                return Promise.resolve();
            });

            // Point the open event at a fresh local emitter BEFORE constructing/activating the
            // env-returning splitter, so the new splitter subscribes to the emitter we fire below.
            const localEmitter = new EventEmitter<NotebookDocument>();
            when(mockedVSCodeNamespaces.workspace.onDidOpenNotebookDocument).thenReturn(localEmitter.event);

            const splitterWithEnv = new DeepnoteMultiNotebookSplitter(
                instance(envMock),
                () => {
                    refreshTreeCount++;
                },
                logger,
                (uri: Uri) => Promise.resolve(existingOnDisk.has(basename(uri)))
            );
            splitterWithEnv.activate();

            localEmitter.fire(notebookDoc(Uri.file('/ws/multi.deepnote')));

            await waitFor(() => removeCalls.length >= 1);
            await settle();

            assert.deepStrictEqual(
                setCalls.sort(),
                ['multi-alpha.deepnote=env-xyz', 'multi-beta.deepnote=env-xyz'],
                'the original env must be copied onto every new sibling'
            );
            assert.deepStrictEqual(removeCalls, ['multi.deepnote'], 'the original mapping must be removed');

            splitterWithEnv.dispose();
            localEmitter.dispose();
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

            assert.isTrue(
                (doc as unknown as { _saved: boolean })._saved,
                'document.save() must be called for a dirty doc'
            );
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
