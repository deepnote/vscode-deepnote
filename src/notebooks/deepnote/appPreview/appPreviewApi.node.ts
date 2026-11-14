import { getInputBlockValueOverrideValidationError, isInputBlock } from '@deepnote/blocks';
import type { IOutput, IStream } from '@deepnote/runtime-core';
import { timingSafeEqual } from 'crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { CancellationTokenSource } from 'vscode';
import { z } from 'zod';

import { concatMultilineString } from '../../../platform/common/utils';
import { isObject } from '../../../platform/common/utils/sysTypes';
import { generateUuid } from '../../../platform/common/uuid';
import type { DeepnoteNotebook } from '../../../platform/deepnote/deepnoteTypes';
import { logger } from '../../../platform/logging';
import type { AppPreviewProject } from './appPreviewSession.node';
import { blocksInNotebookOrder, toNotebookInputs, type WorkspaceNotebook } from './appPreviewWorkspace.node';
import {
    DATAFRAME_NAME_PATTERN,
    DATAFRAME_NOT_FOUND_MESSAGE,
    DataframePageError,
    readStoredDataframePage
} from './storedDataframePage.node';
import type {
    AppPreviewInputValue,
    AppPreviewRunOutcome,
    AppPreviewRunRequest,
    IAppPreviewRunner,
    SnapshotBlock
} from './types';

export interface AppPreviewApiOptions {
    token: string;
    findNotebook(notebookId: string): Promise<WorkspaceNotebook | undefined>;
    /** The project the previewed app belongs to, read again on every dataframe request. */
    getProject(): AppPreviewProject | undefined;
    runner: IAppPreviewRunner;
}

/** A run as Deepnote's `GET /v2/runs/:runId` answers it, without the snapshot fields a local run never has. */
export interface PreviewRun {
    completedAt: string | null;
    createdAt: string;
    error: string | null;
    notebookId: string;
    runId: string;
    snapshotBlocks: AppPreviewRunOutcome['snapshotBlocks'];
    snapshotStatus: 'pending' | 'available' | 'unavailable';
    status: 'pending' | 'running' | AppPreviewRunOutcome['status'];
}

export interface AppPreviewApi {
    router: Router;
    /**
     * The preview's runs by ID, in the order they started. Besides unfinished runs and each notebook's newest
     * successful run, it keeps only the newest {@link MAX_FINISHED_RUNS} finished runs.
     */
    runs: Map<string, PreviewRun>;
    /** Cancels every unfinished run, which stops its kernel once it has one. */
    dispose(): void;
}

// Protocol strings: app code receives them, so they stay English like Deepnote's API messages.
const UNAUTHORIZED_MESSAGE = 'Unauthorized';
const NOT_AVAILABLE_MESSAGE = 'This endpoint is not available to app viewer tokens';
const NOTEBOOK_NOT_FOUND_MESSAGE = 'Notebook not found';
const NO_RUN_RESULTS_MESSAGE = 'You have no run results for this notebook yet. Run the notebook to load them.';
const NO_JSON_OUTPUT_MESSAGE = 'Your latest run has no JSON output.';
const RUN_NOT_FOUND_MESSAGE = 'Run not found';
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

// Each finished run holds all its outputs, and a page may start one on every reload.
const MAX_FINISHED_RUNS = 20;
const MAX_DATAFRAME_PAGE_SIZE = 1000;

const createRunBodySchema = z.strictObject({
    notebookId: z.string().min(1),
    inputs: z.record(z.string().min(1), z.union([z.string(), z.boolean(), z.array(z.string())])).optional(),
    detachedRunStorageMode: z.enum(['read_write', 'readonly']).optional()
});
// Deepnote also requires a UUID `projectId`, but a `.deepnote` file's project id can be any string.
const dataframeParamsSchema = z.object({
    projectId: z.string(),
    name: z.string().regex(DATAFRAME_NAME_PATTERN)
});
const dataframeQuerySchema = z.strictObject({
    pageIndex: z.coerce.number().int().min(0).default(0),
    pageSize: z.coerce.number().int().min(1).max(MAX_DATAFRAME_PAGE_SIZE).default(10)
});

/** The 4xx status of an error body-parser raises for the request itself, such as malformed JSON. */
function clientErrorStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('status' in error) || !('expose' in error)) {
        return undefined;
    }

    return typeof error.status === 'number' && error.status < 500 && error.expose === true ? error.status : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Drops the oldest finished runs beyond {@link MAX_FINISHED_RUNS}. Unfinished runs stay, and so does each notebook's
 * newest successful run, which `appData()` answers from.
 */
function evictFinishedRuns(runs: Map<string, PreviewRun>): void {
    const newestSuccess = new Map<string, string>();
    for (const run of runs.values()) {
        if (run.status === 'success') {
            newestSuccess.set(run.notebookId, run.runId);
        }
    }
    const removable = [...runs.values()].filter(
        (run) => run.completedAt !== null && newestSuccess.get(run.notebookId) !== run.runId
    );
    removable.slice(0, Math.max(0, removable.length - MAX_FINISHED_RUNS)).forEach((run) => runs.delete(run.runId));
}

/**
 * Deepnote's `agentBlockSummary`: the first agent block's first markdown output. runtime-core emits an agent's answer
 * as stream output instead, so without markdown it is the block's stream text.
 */
function firstAgentBlockSummary(blocks: SnapshotBlock[]): string | null {
    const agent = blocks.find((block) => block.type === 'agent');
    if (!agent) {
        return null;
    }

    const markdown = agent.outputs
        .map((output) => mimeData(output, 'text/markdown'))
        .find((data): data is string => typeof data === 'string');
    if (markdown !== undefined) {
        return markdown;
    }
    const streams = agent.outputs.filter((output): output is IStream => output.output_type === 'stream');

    return streams.length > 0 ? streams.map((output) => concatMultilineString(output.text)).join('') : null;
}

/** Deepnote's `appData`: the first `application/json` output that is an object, not an array or `null`. */
function firstJsonObject(blocks: SnapshotBlock[]): Record<string, unknown> | undefined {
    return blocks
        .flatMap((block) => block.outputs)
        .map((output) => mimeData(output, 'application/json'))
        .find(isJsonObject);
}

/** The input check Deepnote's `POST /v2/runs` makes before it accepts a run. */
function inputsError(notebook: DeepnoteNotebook, inputs: Record<string, AppPreviewInputValue>): string | undefined {
    const inputBlocks = notebook.blocks.filter(isInputBlock);
    for (const [name, value] of Object.entries(inputs)) {
        const blocks = inputBlocks.filter((block) => block.metadata.deepnote_variable_name === name);
        if (blocks.length === 0) {
            return `Input "${name}" is not defined for this notebook`;
        }
        for (const block of blocks) {
            const error = getInputBlockValueOverrideValidationError(block, value);
            if (error) {
                return `Input "${name}" ${error}`;
            }
        }
    }

    return undefined;
}

function isAuthorized(authorizationHeader: string | undefined, token: string): boolean {
    if (authorizationHeader === undefined) {
        return false;
    }

    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorizationHeader);

    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// isObject's own guard is `obj is any`, which would switch off type checking where it narrows.
function isJsonObject(value: unknown): value is Record<string, unknown> {
    return isObject(value);
}

function mimeData(output: IOutput, mimeType: string): unknown {
    const data: unknown = output.data;

    return isJsonObject(data) ? data[mimeType] : undefined;
}

function newestSuccessfulRun(runs: Map<string, PreviewRun>, notebookId: string): PreviewRun | undefined {
    let newest: PreviewRun | undefined;
    for (const run of runs.values()) {
        if (
            run.notebookId === notebookId &&
            run.status === 'success' &&
            (!newest || run.createdAt >= newest.createdAt)
        ) {
            newest = run;
        }
    }

    return newest;
}

/** Deepnote's 400 message for a body that fails its schema. */
function readableErrors(error: z.ZodError): string {
    return error.issues
        .map((issue) =>
            issue.path.length === 0
                ? issue.message
                : `${issue.path.map(String).join('.')} ${issue.message.toLowerCase()}`
        )
        .join('; ');
}

/**
 * The `notebook` of Deepnote's `GET /v2/notebooks/:notebookId` answer. Notebooks carry no timestamps in a `.deepnote`
 * file, so `createdAt` is the file's, and a local notebook has no Deepnote schedule or runs.
 */
function toAppViewerNotebook({ file, notebook }: WorkspaceNotebook) {
    return {
        id: notebook.id,
        projectId: file.project.id,
        name: notebook.name,
        createdAt: file.metadata.createdAt,
        isInit: notebook.id === file.project.initNotebookId,
        isScheduled: false,
        lastRunAt: null,
        lastRunId: null,
        inputs: toNotebookInputs(notebook),
        blocks: blocksInNotebookOrder(notebook).map(({ id, type }) => ({ id, type }))
    };
}

/**
 * The local stand-in for Deepnote's app viewer API (`/v2`), mounted at `/__deepnote/v2` on the preview server.
 * Requests without the preview's bearer token get 401. `GET /notebooks/:notebookId` answers from the workspace's
 * notebooks, and `POST /runs` runs one with `runner`, which `GET /runs/:runId` then reports on.
 * `GET /notebooks/:notebookId/app-data` answers from the notebook's newest successful run, and
 * `GET /projects/:projectId/dataframes/:name` from the dataframes stored in the folder of `getProject()`'s project.
 * Every other route gets 403, as Deepnote answers app viewer tokens. A body that cannot be read, such as malformed
 * JSON, gets its 4xx; any other failure is logged and gets a JSON 500.
 */
export function createAppPreviewApi(options: AppPreviewApiOptions): AppPreviewApi {
    const router = express.Router();
    const runs = new Map<string, PreviewRun>();
    const unfinished = new Set<CancellationTokenSource>();

    const startRun = (run: PreviewRun, request: AppPreviewRunRequest) => {
        const cancellation = new CancellationTokenSource();
        unfinished.add(cancellation);
        void options.runner
            .run(request, cancellation.token, () => {
                run.status = 'running';
            })
            .catch((error): AppPreviewRunOutcome => {
                logger.error(`AppPreviewApi: Run ${run.runId} failed`, error);

                return { status: 'internal_error', error: errorMessage(error), snapshotBlocks: null };
            })
            .then((outcome) => {
                run.status = outcome.status;
                run.error = outcome.error;
                run.snapshotBlocks = outcome.snapshotBlocks;
                run.snapshotStatus =
                    outcome.status === 'success' || outcome.status === 'error' ? 'available' : 'unavailable';
                run.completedAt = new Date().toISOString();
                evictFinishedRuns(runs);
            })
            .finally(() => {
                unfinished.delete(cancellation);
                cancellation.dispose();
            });
    };

    router.use((req: Request, res: Response, next: NextFunction) => {
        if (!isAuthorized(req.headers.authorization, options.token)) {
            res.status(401).json({ message: UNAUTHORIZED_MESSAGE });

            return;
        }
        next();
    });

    router.get('/notebooks/:notebookId', async (req: Request<{ notebookId: string }>, res: Response) => {
        const found = await options.findNotebook(req.params.notebookId);
        if (!found) {
            res.status(404).json({ message: NOTEBOOK_NOT_FOUND_MESSAGE });

            return;
        }
        res.json({ notebook: toAppViewerNotebook(found) });
    });
    router.get('/notebooks/:notebookId/app-data', async (req: Request<{ notebookId: string }>, res: Response) => {
        const { notebookId } = req.params;
        if (!(await options.findNotebook(notebookId))) {
            res.status(404).json({ message: NOTEBOOK_NOT_FOUND_MESSAGE });

            return;
        }
        const run = newestSuccessfulRun(runs, notebookId);
        if (!run) {
            res.status(404).json({ message: NO_RUN_RESULTS_MESSAGE });

            return;
        }
        const blocks = run.snapshotBlocks ?? [];
        const appData = firstJsonObject(blocks);
        if (!appData) {
            res.status(404).json({ message: NO_JSON_OUTPUT_MESSAGE });

            return;
        }
        res.json({ appData, agentBlockSummary: firstAgentBlockSummary(blocks), runCreatedAt: run.createdAt });
    });
    router.post('/runs', express.json(), async (req: Request, res: Response) => {
        const parsed = createRunBodySchema.safeParse(req.body, {
            // Deepnote's error map, so a missing field reads `is required`.
            error: (issue) => (issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : undefined)
        });
        if (!parsed.success) {
            res.status(400).json({ message: readableErrors(parsed.error) });

            return;
        }

        const { notebookId, inputs = {} } = parsed.data;
        const found = await options.findNotebook(notebookId);
        // Unlike its GET routes, Deepnote answers 400 here.
        if (!found) {
            res.status(400).json({ message: NOTEBOOK_NOT_FOUND_MESSAGE });

            return;
        }
        const inputError = inputsError(found.notebook, inputs);
        if (inputError) {
            res.status(400).json({ message: inputError });

            return;
        }

        const run: PreviewRun = {
            runId: generateUuid(),
            notebookId,
            status: 'pending',
            snapshotStatus: 'pending',
            snapshotBlocks: null,
            error: null,
            createdAt: new Date().toISOString(),
            completedAt: null
        };
        runs.set(run.runId, run);
        startRun(run, { fileUri: found.fileUri, notebookId, inputs });
        res.status(202).json({ runId: run.runId, status: run.status, createdAt: run.createdAt });
    });
    router.get('/runs/:runId', (req: Request<{ runId: string }>, res: Response) => {
        const run = runs.get(req.params.runId);
        if (!run) {
            res.status(404).json({ message: RUN_NOT_FOUND_MESSAGE });

            return;
        }
        res.json({ run: { ...run, snapshotExpiresAt: null, snapshotContent: null, snapshotDownloadUrl: null } });
    });
    router.get('/projects/:projectId/dataframes/:name', async (req: Request, res: Response) => {
        const params = dataframeParamsSchema.safeParse(req.params);
        if (!params.success) {
            res.status(400).json({ message: readableErrors(params.error) });

            return;
        }
        const query = dataframeQuerySchema.safeParse(req.query);
        if (!query.success) {
            res.status(400).json({ message: readableErrors(query.error) });

            return;
        }
        const project = options.getProject();
        if (!project || project.id !== params.data.projectId) {
            res.status(404).json({ message: DATAFRAME_NOT_FOUND_MESSAGE });

            return;
        }

        try {
            res.json(await readStoredDataframePage(project.folder, params.data.name, query.data));
        } catch (error) {
            if (!(error instanceof DataframePageError)) {
                throw error;
            }
            res.status(error.status).json({ message: error.message });
        }
    });

    router.use((_req: Request, res: Response) => {
        res.status(403).json({ message: NOT_AVAILABLE_MESSAGE });
    });
    // Express's own handler would answer an HTML page that holds the stack, and log it outside the extension's logger.
    router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
        const status = clientErrorStatus(error);
        if (status !== undefined) {
            res.status(status).json({ message: errorMessage(error) });

            return;
        }
        logger.error(`AppPreviewApi: ${req.method} ${req.path} failed`, error);
        res.status(500).json({ message: INTERNAL_ERROR_MESSAGE });
    });

    return {
        router,
        runs,
        dispose: () => unfinished.forEach((cancellation) => cancellation.cancel())
    };
}
