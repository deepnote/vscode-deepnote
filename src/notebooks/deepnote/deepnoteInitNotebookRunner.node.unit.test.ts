import { serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { EventEmitter, FileType, NotebookDocument, Uri } from 'vscode';

import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../kernels/types';
import { IDisposableRegistry } from '../../platform/common/types';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteInitNotebookRunner } from './deepnoteInitNotebookRunner.node';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-2222-2222-222222222222';
const INIT_NOTEBOOK_ID = 'init-notebook-id';
const MAIN_NOTEBOOK_ID = 'main-notebook-id';

const DIR_PATH = '/workspace/project';
const MAIN_FILE_NAME = 'main.deepnote';
const SIBLING_INIT_FILE_NAME = 'init.deepnote';

// The init's single CODE block content — the marker we assert flows through to executeHidden.
const SIBLING_INIT_CODE = 'pip install sibling-init-package';
// Content that ONLY lives in the main file's notebooks — must NEVER be executed.
const MAIN_FILE_BLOCK_CODE = 'print("this is a main-file block, not init")';

const waitTimeoutMs = 5000;
const waitIntervalMs = 5;

// A kernel is WeakSet-marked only after runInitForKernel returns, past the runner's ~1000ms
// display delay (INIT_COMPLETE_DISPLAY_DELAY_MS); a second start for the same kernel must wait past it.
const INIT_COMPLETE_DISPLAY_DELAY_MS = 1000;
const RUN_FULLY_SETTLED_MS = INIT_COMPLETE_DISPLAY_DELAY_MS + 300;

/** Poll until `condition` is true (used to await the async, event-driven init run). */
async function waitFor(condition: () => boolean, timeoutMs = waitTimeoutMs): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitFor timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
    }
}

/** A short settle window used to PROVE that nothing further happened (no executeHidden, no scan). */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 120));
}

/** Wait long enough that a started init run has fully returned and its kernel is WeakSet-marked. */
function waitForRunFullySettled(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, RUN_FULLY_SETTLED_MS));
}

function basename(uri: Uri): string {
    return uri.path.split('/').pop() ?? '';
}

/**
 * Build a single-notebook DeepnoteFile whose one notebook carries the given code blocks (in order).
 * Appends a trailing markdown block so the runner's `type === 'code'` filter is exercised
 * (only the code blocks must produce executeHidden calls — the markdown must be skipped).
 */
function makeNotebookFile(projectId: string, notebookId: string, codeContents: string[]): DeepnoteFile {
    const codeBlocks = codeContents.map((content, index): DeepnoteNotebook['blocks'][number] => ({
        id: `${notebookId}-code-${index}`,
        type: 'code',
        sortingKey: `a${index}`,
        blockGroup: 'g',
        content,
        metadata: {}
    }));

    return {
        version: '1.0.0',
        metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
        project: {
            id: projectId,
            name: 'Proj',
            notebooks: [
                {
                    id: notebookId,
                    name: 'Init',
                    blocks: [
                        ...codeBlocks,
                        {
                            id: `${notebookId}-md`,
                            type: 'markdown',
                            sortingKey: `a${codeContents.length}`,
                            blockGroup: 'g',
                            content: '# notes',
                            metadata: {}
                        }
                    ]
                }
            ]
        }
    };
}

/** The cached project entry the manager returns for `getProjectForNotebook` (carries initNotebookId). */
function makeMainProjectEntry(projectId: string, initNotebookId: string | undefined): DeepnoteFile {
    return {
        version: '1.0.0',
        metadata: { createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2021-01-01T00:00:00Z' },
        project: {
            id: projectId,
            name: 'Proj',
            ...(initNotebookId ? { initNotebookId } : {}),
            notebooks: [
                {
                    id: MAIN_NOTEBOOK_ID,
                    name: 'Main',
                    blocks: [
                        {
                            id: 'main-b',
                            type: 'code',
                            sortingKey: 'a0',
                            blockGroup: 'g',
                            content: MAIN_FILE_BLOCK_CODE,
                            metadata: {}
                        }
                    ]
                }
            ]
        }
    };
}

suite('DeepnoteInitNotebookRunner', () => {
    let runner: DeepnoteInitNotebookRunner;

    let mockNotebookManager: IDeepnoteNotebookManager;
    let mockKernelProvider: IKernelProvider;
    let mockDisposables: IDisposableRegistry;

    let onDidStartKernel: EventEmitter<IKernel>;
    let onDidRestartKernel: EventEmitter<IKernel>;

    // Spy capturing every executeHidden(code) call across all kernels.
    let executeHiddenSpy: sinon.SinonStub;

    // Directory listing returned by workspace.fs.readDirectory (basename → present on disk).
    let directoryEntries: [string, FileType][];
    // basename → serialized .deepnote bytes for workspace.fs.readFile.
    let fileBytesByName: Map<string, Uint8Array>;
    // Counts readDirectory invocations, so we can prove a missing sibling is NOT permanently marked.
    let readDirectoryCount: number;

    function putFile(name: string, file: DeepnoteFile): void {
        fileBytesByName.set(name, new TextEncoder().encode(serializeDeepnoteFile(file)));
        if (!directoryEntries.some(([n]) => n === name)) {
            directoryEntries.push([name, FileType.File]);
        }
    }

    /**
     * Build an IKernel whose `.notebook` points at the given file URI. Each kernel is a
     * DISTINCT object identity, so the runner's WeakSet<IKernel> gate treats them separately.
     */
    function makeKernel(fileName: string, opts?: { notebookType?: string; projectId?: string }): IKernel {
        const uri = Uri.file(`${DIR_PATH}/${fileName}`);
        const notebook = {
            uri,
            notebookType: opts?.notebookType ?? 'deepnote',
            metadata: { deepnoteProjectId: opts?.projectId ?? PROJECT_ID, deepnoteNotebookId: MAIN_NOTEBOOK_ID }
        } as unknown as NotebookDocument;

        return { notebook } as unknown as IKernel;
    }

    setup(() => {
        resetVSCodeMocks();

        mockNotebookManager = mock<IDeepnoteNotebookManager>();
        mockKernelProvider = mock<IKernelProvider>();
        mockDisposables = mock<IDisposableRegistry>();

        onDidStartKernel = new EventEmitter<IKernel>();
        onDidRestartKernel = new EventEmitter<IKernel>();
        when(mockKernelProvider.onDidStartKernel).thenReturn(onDidStartKernel.event);
        when(mockKernelProvider.onDidRestartKernel).thenReturn(onDidRestartKernel.event);

        // get(notebook) must return a kernel — the runner re-fetches it inside executeInitNotebookImpl.
        // Return any non-undefined kernel; the impl only uses it to call getKernelExecution.
        when(mockKernelProvider.get(anything())).thenReturn(instance(mock<IKernel>()));

        executeHiddenSpy = sinon.stub().callsFake(() => Promise.resolve([]));
        when(mockKernelProvider.getKernelExecution(anything())).thenReturn({
            executeHidden: executeHiddenSpy
        } as unknown as INotebookKernelExecution);

        // Default cached project: has an init notebook configured.
        when(mockNotebookManager.getProjectForNotebook(PROJECT_ID, MAIN_NOTEBOOK_ID)).thenReturn(
            makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID)
        );

        directoryEntries = [];
        fileBytesByName = new Map<string, Uint8Array>();
        readDirectoryCount = 0;

        const mockFs = mock<typeof import('vscode').workspace.fs>();
        when(mockFs.readDirectory(anything())).thenCall(() => {
            readDirectoryCount++;
            return Promise.resolve(directoryEntries.map(([n, t]) => [n, t] as [string, FileType]));
        });
        when(mockFs.readFile(anything())).thenCall((uri: Uri) => {
            const bytes = fileBytesByName.get(basename(uri));
            if (!bytes) {
                return Promise.reject(new Error(`no such file: ${basename(uri)}`));
            }
            return Promise.resolve(bytes);
        });
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

        runner = new DeepnoteInitNotebookRunner(
            instance(mockNotebookManager),
            instance(mockKernelProvider),
            instance(mockDisposables)
        );
        runner.activate();
    });

    teardown(() => {
        sinon.restore();
    });

    test('runs init from the SIBLING file (not the main file) — post-migration the init is not in main.project.notebooks', async () => {
        // Main file's cached project references INIT_NOTEBOOK_ID but does NOT contain it; the
        // init lives in a sibling .deepnote in the same directory.
        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));
        putFile(SIBLING_INIT_FILE_NAME, makeNotebookFile(PROJECT_ID, INIT_NOTEBOOK_ID, [SIBLING_INIT_CODE]));

        const kernel = makeKernel(MAIN_FILE_NAME);
        onDidStartKernel.fire(kernel);

        // One code block in the sibling init → exactly one executeHidden call.
        await waitFor(() => executeHiddenSpy.callCount >= 1);

        assert.strictEqual(executeHiddenSpy.callCount, 1, 'exactly the sibling init code block should run');
        assert.strictEqual(
            executeHiddenSpy.firstCall.args[0],
            SIBLING_INIT_CODE,
            'must execute the SIBLING init block content'
        );
        // The main file's own block content must never be executed.
        assert.isFalse(
            executeHiddenSpy.getCalls().some((c) => c.args[0] === MAIN_FILE_BLOCK_CODE),
            'must NOT run anything from the main file notebooks'
        );
    });

    test('missing sibling → logged and NOT permanently marked: a later NEW kernel re-scans the directory', async () => {
        // initNotebookId is configured, but NO valid sibling exists on disk (only the main file).
        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));

        const kernelA = makeKernel(MAIN_FILE_NAME);
        onDidStartKernel.fire(kernelA);
        await settle();

        assert.strictEqual(executeHiddenSpy.callCount, 0, 'no init should run when the sibling is missing');
        const scansAfterFirst = readDirectoryCount;
        assert.isAtLeast(scansAfterFirst, 1, 'the first start must attempt a directory scan');

        // A brand-new kernel (different IKernel identity) must re-scan — the project was NOT
        // permanently marked, so a later-added/fixed sibling would be picked up.
        const kernelB = makeKernel(MAIN_FILE_NAME);
        onDidStartKernel.fire(kernelB);
        await waitFor(() => readDirectoryCount > scansAfterFirst);

        assert.isAbove(readDirectoryCount, scansAfterFirst, 'a new kernel must re-scan (not permanently marked)');
        assert.strictEqual(executeHiddenSpy.callCount, 0, 'still nothing to run while the sibling is absent');
    });

    test('same kernel start fires twice → init runs only once (WeakSet gate prevents doubling)', async () => {
        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));
        putFile(SIBLING_INIT_FILE_NAME, makeNotebookFile(PROJECT_ID, INIT_NOTEBOOK_ID, [SIBLING_INIT_CODE]));

        const kernel = makeKernel(MAIN_FILE_NAME);

        onDidStartKernel.fire(kernel);
        await waitFor(() => executeHiddenSpy.callCount >= 1);
        // The WeakSet marker is set only after the run fully returns (past the display delay);
        // wait for that so the second start actually exercises the gate (not a race before marking).
        await waitForRunFullySettled();

        // Fire start AGAIN for the same kernel instance — the WeakSet gate must short-circuit it.
        onDidStartKernel.fire(kernel);
        await settle();

        assert.strictEqual(
            executeHiddenSpy.callCount,
            1,
            'a repeated start for the same kernel must NOT run init a second time'
        );
    });

    test('RESTART re-runs init even though the kernel already ran it (onDidRestartKernel is unconditional)', async () => {
        // An in-place restart fires onDidRestartKernel (NOT onDidStartKernel) and loses all
        // in-kernel state, so init MUST re-run before the next user cell.
        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));
        putFile(SIBLING_INIT_FILE_NAME, makeNotebookFile(PROJECT_ID, INIT_NOTEBOOK_ID, [SIBLING_INIT_CODE]));

        const kernel = makeKernel(MAIN_FILE_NAME);

        // First start runs init once and (after the run fully settles) marks the kernel in the
        // WeakSet — so the restart below proves re-run despite an ALREADY-SET gate, not a race.
        onDidStartKernel.fire(kernel);
        await waitFor(() => executeHiddenSpy.callCount >= 1);
        assert.strictEqual(executeHiddenSpy.callCount, 1, 'start runs init once');
        await waitForRunFullySettled();

        // Sanity: a repeated START would now be gated (kernel is marked) — so the second run
        // below can only come from the restart path being unconditional.
        onDidStartKernel.fire(kernel);
        await settle();
        assert.strictEqual(executeHiddenSpy.callCount, 1, 'a repeated start is gated once the kernel is marked');

        // Restart the SAME (already-marked) kernel — init MUST run a SECOND time regardless.
        onDidRestartKernel.fire(kernel);
        await waitFor(() => executeHiddenSpy.callCount >= 2);

        assert.strictEqual(executeHiddenSpy.callCount, 2, 'restart must re-run init (a second executeHidden pass)');
        assert.strictEqual(
            executeHiddenSpy.secondCall.args[0],
            SIBLING_INIT_CODE,
            'the restart re-run executes the sibling init block again'
        );
    });

    test('non-deepnote kernel is ignored: onDidStartKernel for a non-deepnote notebook does nothing', async () => {
        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));
        putFile(SIBLING_INIT_FILE_NAME, makeNotebookFile(PROJECT_ID, INIT_NOTEBOOK_ID, [SIBLING_INIT_CODE]));

        const kernel = makeKernel(MAIN_FILE_NAME, { notebookType: 'jupyter-notebook' });
        onDidStartKernel.fire(kernel);
        await settle();

        assert.strictEqual(executeHiddenSpy.callCount, 0, 'a non-deepnote kernel must not trigger init');
        assert.strictEqual(readDirectoryCount, 0, 'a non-deepnote kernel must not even scan for siblings');
    });

    test('closing the notebook mid-init stops remaining init blocks (close cancels the run)', async () => {
        // runInitForKernel must pass a close-tied token into executeInitNotebook, so closing the
        // notebook mid-init stops remaining blocks. Without it, both blocks run regardless of close.
        const FIRST_BLOCK_CODE = 'pip install first-init-package';
        const SECOND_BLOCK_CODE = 'pip install second-init-package';

        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));
        putFile(
            SIBLING_INIT_FILE_NAME,
            makeNotebookFile(PROJECT_ID, INIT_NOTEBOOK_ID, [FIRST_BLOCK_CODE, SECOND_BLOCK_CODE])
        );

        // Wire a close emitter we can fire (the runner subscribes to workspace.onDidCloseNotebookDocument).
        const onDidCloseNotebookDocument = new EventEmitter<NotebookDocument>();
        when(mockedVSCodeNamespaces.workspace.onDidCloseNotebookDocument).thenReturn(onDidCloseNotebookDocument.event);

        // Hold the FIRST block's execution open so we can fire close while init is mid-loop. The
        // second block must never run because the per-block cancellation check trips after close.
        let resolveFirstBlock!: () => void;
        const firstBlockGate = new Promise<[]>((resolve) => {
            resolveFirstBlock = () => resolve([]);
        });
        executeHiddenSpy.callsFake((code: string) =>
            code === FIRST_BLOCK_CODE ? firstBlockGate : Promise.resolve([])
        );

        const kernel = makeKernel(MAIN_FILE_NAME);
        onDidStartKernel.fire(kernel);

        // Wait until the first block is in flight (its executeHidden has been called and is pending).
        await waitFor(() => executeHiddenSpy.callCount >= 1);
        assert.strictEqual(executeHiddenSpy.callCount, 1, 'the first init block should be executing');
        assert.strictEqual(executeHiddenSpy.firstCall.args[0], FIRST_BLOCK_CODE, 'first block runs first');

        // Close the notebook (URI-matched) — this must cancel the run's token.
        onDidCloseNotebookDocument.fire(kernel.notebook);

        // Let the first block finish; the loop then re-checks the (now cancelled) token before block 2.
        resolveFirstBlock();
        await settle();

        assert.strictEqual(executeHiddenSpy.callCount, 1, 'after close, the remaining init block(s) must NOT execute');
        assert.isFalse(
            executeHiddenSpy.getCalls().some((c) => c.args[0] === SECOND_BLOCK_CODE),
            'the second init block must never run once the notebook is closed mid-init'
        );
    });

    test('sibling of a DIFFERENT project is not a valid init source (project.id must match)', async () => {
        // A sibling exists with the right initNotebookId-shaped notebook but a different project.id.
        putFile(MAIN_FILE_NAME, makeMainProjectEntry(PROJECT_ID, INIT_NOTEBOOK_ID));
        putFile(SIBLING_INIT_FILE_NAME, makeNotebookFile(OTHER_PROJECT_ID, INIT_NOTEBOOK_ID, [SIBLING_INIT_CODE]));

        const kernel = makeKernel(MAIN_FILE_NAME);
        onDidStartKernel.fire(kernel);
        await settle();

        assert.strictEqual(
            executeHiddenSpy.callCount,
            0,
            'a sibling whose project.id does not match must be rejected as an init source'
        );
    });
});
