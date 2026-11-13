import { generateSortingKey, type DeepnoteFile } from '@deepnote/blocks';
import { ExecutionEngine, type BlockExecutionResult, type IError, type IOutput } from '@deepnote/runtime-core';
import { inject, injectable } from 'inversify';
import { workspace, type CancellationToken, type Uri } from 'vscode';

import {
    DeepnoteToolkitDependencyResponse,
    IDeepnoteServerStarter,
    IDeepnoteToolkitDependencyService
} from '../../../kernels/deepnote/types';
import { Cancellation } from '../../../platform/common/cancellation';
import { getDisplayPath, getFilePath } from '../../../platform/common/platform/fs-paths.node';
import { DeepnoteAppPreview } from '../../../platform/common/utils/localize';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import type { DeepnoteNotebook } from '../../../platform/deepnote/deepnoteTypes';
import { logger } from '../../../platform/logging';
import * as path from '../../../platform/vscode-path/path';
import { adaptInitBlockContent, findSiblingInitNotebook } from '../deepnoteInitNotebookRunner.node';
import { IDeepnoteNotebookInterpreters } from '../deepnoteNotebookInterpreters';
import { blocksInNotebookOrder } from './appPreviewWorkspace.node';
import type {
    AppPreviewInputValue,
    AppPreviewRunOutcome,
    AppPreviewRunRequest,
    IAppPreviewRunner,
    SnapshotBlock
} from './types';

// Deepnote's run error for a failing init block, so app code sees the same message as in Deepnote.
const INIT_NOTEBOOK_FAILED_PREFIX = 'Init notebook failed: ';

const STOPPED: AppPreviewRunOutcome = { status: 'stopped', error: null, snapshotBlocks: null };

interface NotebookRun {
    failure: BlockExecutionResult | undefined;
    outputs: Map<string, IOutput[]>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** runtime-core sets `error` only when running the block threw; a Python exception arrives as an `error` output. */
function failureMessage(result: BlockExecutionResult): string {
    if (result.error?.message) {
        return result.error.message;
    }

    const output = result.outputs.find((candidate): candidate is IError => candidate.output_type === 'error');
    const detail = output ? [output.ename, output.evalue].filter(Boolean).join(': ') : '';

    return detail || DeepnoteAppPreview.blockFailed(result.blockId);
}

async function findInitNotebook(
    file: DeepnoteFile,
    fileUri: Uri,
    notebookId: string
): Promise<DeepnoteNotebook | undefined> {
    const { id: projectId, initNotebookId, notebooks } = file.project;
    if (!initNotebookId || initNotebookId === notebookId) {
        return undefined;
    }

    const init =
        notebooks.find((notebook) => notebook.id === initNotebookId) ??
        (await findSiblingInitNotebook(fileUri, projectId, initNotebookId));
    if (!init) {
        logger.warn(`AppPreviewRunner: No init notebook ${initNotebookId} found for ${getDisplayPath(fileUri)}`);
    }

    return init;
}

function internalError(message: string): AppPreviewRunOutcome {
    return { status: 'internal_error', error: message, snapshotBlocks: null };
}

/**
 * A copy of `file` that holds only a copy of `notebook`, with its blocks re-keyed `000000`, `000001`, … in Deepnote's
 * order. runtime-core sorts blocks with `localeCompare`, which would run Deepnote's key `a0` before `Z0j`.
 */
function runCopy(file: DeepnoteFile, notebook: DeepnoteNotebook): DeepnoteFile {
    const copy = structuredClone({ ...file, project: { ...file.project, notebooks: [notebook] } });
    const [copied] = copy.project.notebooks;
    copied.blocks = blocksInNotebookOrder(copied);
    copied.blocks.forEach((block, index) => {
        block.sortingKey = generateSortingKey(index);
    });

    return copy;
}

async function runNotebook(
    engine: ExecutionEngine,
    file: DeepnoteFile,
    inputs?: Record<string, AppPreviewInputValue>
): Promise<NotebookRun> {
    const outputs = new Map<string, IOutput[]>();
    let failure: BlockExecutionResult | undefined;
    const summary = await engine.runProject(file, {
        ...(inputs ? { inputs } : {}),
        onBlockDone: (result) => {
            outputs.set(result.blockId, result.outputs);
            if (!result.success) {
                failure = result;
            }
        }
    });

    // A failed code block an agent added does not stop the run, so only a run that stopped has failed.
    return { failure: summary.failedBlocks > 0 ? failure : undefined, outputs };
}

/** The run's copy of the notebook, input overrides included, with the outputs of this run. */
function snapshotBlocksOf(file: DeepnoteFile, outputs: Map<string, IOutput[]>): SnapshotBlock[] {
    return file.project.notebooks[0].blocks.map((block) => ({
        id: block.id,
        type: block.type,
        outputs: outputs.get(block.id) ?? [],
        metadata: block.metadata ?? {},
        outputHead: null,
        outputTail: null
    }));
}

/**
 * Runs a workspace notebook for the app preview's `run()` the way Deepnote runs one for an app: in a fresh kernel, the
 * init notebook first with its saved inputs, then the notebook with the page's inputs. The kernel is a session of its
 * own on the toolkit server the extension runs for the notebook's `.deepnote` file.
 */
@injectable()
export class AppPreviewRunner implements IAppPreviewRunner {
    constructor(
        @inject(IDeepnoteNotebookInterpreters) private readonly interpreters: IDeepnoteNotebookInterpreters,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter,
        @inject(IDeepnoteToolkitDependencyService) private readonly toolkit: IDeepnoteToolkitDependencyService
    ) {}

    public async run(
        request: AppPreviewRunRequest,
        token: CancellationToken,
        onRunning: () => void
    ): Promise<AppPreviewRunOutcome> {
        let running = false;
        try {
            return await this.execute(request, token, () => {
                running = true;
                onRunning();
            });
        } catch (error) {
            if (!running && token.isCancellationRequested) {
                return STOPPED;
            }
            logger.error(
                `AppPreviewRunner: Could not run the notebook ${request.notebookId} of ${getDisplayPath(
                    request.fileUri
                )}`,
                error
            );

            return internalError(errorMessage(error));
        }
    }

    private async execute(
        { fileUri, inputs, notebookId }: AppPreviewRunRequest,
        token: CancellationToken,
        onRunning: () => void
    ): Promise<AppPreviewRunOutcome> {
        const file = await readDeepnoteProjectFile(fileUri);
        const target = file.project.notebooks.find((notebook) => notebook.id === notebookId);
        if (!target) {
            throw new Error(DeepnoteAppPreview.notebookNotInFile(notebookId));
        }
        const init = await findInitNotebook(file, fileUri, notebookId);
        const targetCopy = runCopy(file, target);
        const initCopy = init ? runCopy(file, init) : undefined;
        for (const block of initCopy?.project.notebooks[0].blocks ?? []) {
            if (block.type === 'code') {
                block.content = adaptInitBlockContent(block.content ?? '');
            }
        }

        // The integration endpoint gives a kernel its SQL credentials only for notebooks open in VS Code.
        await workspace.openNotebookDocument(fileUri);
        Cancellation.throwIfCanceled(token);

        const interpreter = await this.interpreters.resolve(fileUri);
        Cancellation.throwIfCanceled(token);
        if (!interpreter) {
            return internalError(DeepnoteAppPreview.noInterpreter);
        }

        const dependency = await this.toolkit.ensureToolkitInstalled(interpreter, fileUri, token);
        Cancellation.throwIfCanceled(token);
        if (dependency !== DeepnoteToolkitDependencyResponse.ok) {
            return internalError(DeepnoteAppPreview.toolkitNotInstalled);
        }

        const server = await this.serverStarter.startServer(interpreter, fileUri, token);
        Cancellation.throwIfCanceled(token);

        logger.info(`AppPreviewRunner: Running the notebook ${notebookId} of ${getDisplayPath(fileUri)}`);
        const engine = new ExecutionEngine(
            { pythonEnv: getFilePath(interpreter.uri), workingDirectory: path.dirname(fileUri.fsPath) },
            { server }
        );
        try {
            await engine.start();
            Cancellation.throwIfCanceled(token);
            onRunning();

            if (initCopy) {
                const { failure } = await runNotebook(engine, initCopy);
                if (failure) {
                    return {
                        status: 'error',
                        error: `${INIT_NOTEBOOK_FAILED_PREFIX}${failureMessage(failure)}`,
                        snapshotBlocks: snapshotBlocksOf(targetCopy, new Map())
                    };
                }
            }

            const { failure, outputs } = await runNotebook(engine, targetCopy, inputs);

            return {
                status: failure ? 'error' : 'success',
                error: failure ? failureMessage(failure) : null,
                snapshotBlocks: snapshotBlocksOf(targetCopy, outputs)
            };
        } finally {
            await engine.stop();
        }
    }
}
