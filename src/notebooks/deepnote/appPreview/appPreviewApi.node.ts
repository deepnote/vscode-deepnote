import { timingSafeEqual } from 'crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import { logger } from '../../../platform/logging';
import { blocksInNotebookOrder, toNotebookInputs, type WorkspaceNotebook } from './appPreviewWorkspace.node';

export type AppPreviewOperation = 'appData()' | 'run()' | 'dataframe()';

export interface AppPreviewApiOptions {
    token: string;
    findNotebook(notebookId: string): Promise<WorkspaceNotebook | undefined>;
    onUnsupported(operation: AppPreviewOperation): void;
}

// Protocol strings: app code receives them, so they stay English like Deepnote's API messages.
const UNAUTHORIZED_MESSAGE = 'Unauthorized';
const NOT_AVAILABLE_MESSAGE = 'This endpoint is not available to app viewer tokens';
const NOTEBOOK_NOT_FOUND_MESSAGE = 'Notebook not found';
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

function notSupportedMessage(operation: AppPreviewOperation): string {
    return `${operation} is not supported in the local preview yet.`;
}

function isAuthorized(authorizationHeader: string | undefined, token: string): boolean {
    if (authorizationHeader === undefined) {
        return false;
    }

    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorizationHeader);

    return actual.length === expected.length && timingSafeEqual(actual, expected);
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
 * notebooks, the other routes Deepnote's client calls get 501, and every other route gets 403, as Deepnote answers app
 * viewer tokens. A handler that fails is logged and gets a JSON 500.
 */
export function createAppPreviewApi(options: AppPreviewApiOptions): Router {
    const router = express.Router();

    const unsupported = (operation: AppPreviewOperation) => (_req: Request, res: Response) => {
        options.onUnsupported(operation);
        res.status(501).json({ message: notSupportedMessage(operation) });
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
    router.get('/notebooks/:notebookId/app-data', unsupported('appData()'));
    router.post('/runs', unsupported('run()'));
    router.get('/runs/:runId', unsupported('run()'));
    router.get('/projects/:projectId/dataframes/:name', unsupported('dataframe()'));

    router.use((_req: Request, res: Response) => {
        res.status(403).json({ message: NOT_AVAILABLE_MESSAGE });
    });
    // Express's own handler would answer an HTML page that holds the stack, and log it outside the extension's logger.
    router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
        logger.error(`AppPreviewApi: ${req.method} ${req.path} failed`, error);
        res.status(500).json({ message: INTERNAL_ERROR_MESSAGE });
    });

    return router;
}
