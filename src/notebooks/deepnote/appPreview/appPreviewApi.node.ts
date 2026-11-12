import { timingSafeEqual } from 'crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

export type AppPreviewOperation = 'inputs()' | 'appData()' | 'run()' | 'dataframe()';

export interface AppPreviewApiOptions {
    token: string;
    onUnsupported(operation: AppPreviewOperation): void;
}

// Protocol strings: app code receives them, so they stay English like Deepnote's API messages.
const UNAUTHORIZED_MESSAGE = 'Unauthorized';
const NOT_AVAILABLE_MESSAGE = 'This endpoint is not available to app viewer tokens';

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
 * The local stand-in for Deepnote's app viewer API (`/v2`), mounted at `/__deepnote/v2` on the preview server.
 * Requests without the preview's bearer token get 401, the routes Deepnote's client calls get 501, and every other
 * route gets 403, as Deepnote answers app viewer tokens.
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

    router.get('/notebooks/:notebookId', unsupported('inputs()'));
    router.get('/notebooks/:notebookId/app-data', unsupported('appData()'));
    router.post('/runs', unsupported('run()'));
    router.get('/runs/:runId', unsupported('run()'));
    router.get('/projects/:projectId/dataframes/:name', unsupported('dataframe()'));

    router.use((_req: Request, res: Response) => {
        res.status(403).json({ message: NOT_AVAILABLE_MESSAGE });
    });

    return router;
}
