import { timingSafeEqual } from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';
import { inject, injectable } from 'inversify';
import { commands, l10n, window, workspace } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { generateUuid } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import { ISqlIntegrationEnvVarsProvider, IUserpodApiEndpoints } from '../../../platform/notebooks/deepnote/types';

/** Loopback host for the toolkit's `userpod-api` calls; currently serves integration env vars for `set_integration_env()` (as `[{name,value}]`). */
@injectable()
export class UserpodApiEndpoints implements IUserpodApiEndpoints, IExtensionSyncActivationService {
    private readonly authTokensByProject = new Map<string, string>();
    private isListening = false;
    private server: http.Server | undefined;
    private serverBaseUrl: string | undefined;
    private startAttempt: Promise<void> = Promise.resolve();

    constructor(
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVarsProvider: ISqlIntegrationEnvVarsProvider,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public get baseUrl(): string | undefined {
        return this.serverBaseUrl;
    }

    /** Settles (never rejects) once the initial bind attempt completes, so callers can await readiness before reading `baseUrl`. */
    public get ready(): Promise<void> {
        return this.startAttempt;
    }

    /** Per-project bearer token, generated on first use, so a kernel can only read its own project's credentials. */
    public getAuthToken(projectId: string): string {
        let token = this.authTokensByProject.get(projectId);
        if (token === undefined) {
            token = generateUuid();
            this.authTokensByProject.set(projectId, token);
        }

        return token;
    }

    public activate(): void {
        this.disposables.push({ dispose: () => this.stop() });
        this.startAttempt = this.start().catch((err) =>
            logger.error('UserpodApiEndpoints: Failed to start integration env vars endpoint', err)
        );
    }

    private isAuthorized(authorizationHeader: string | undefined, projectId: string): boolean {
        if (authorizationHeader === undefined) {
            return false;
        }

        const expectedToken = this.authTokensByProject.get(projectId);
        if (expectedToken === undefined) {
            return false;
        }

        // Constant-time compare: the response carries credentials, so don't leak the token via early-exit timing.
        const expected = Buffer.from(`Bearer ${expectedToken}`);
        const actual = Buffer.from(authorizationHeader);

        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    private onServerError(err: Error): void {
        logger.error('UserpodApiEndpoints: HTTP server error', err);

        // Startup failures are surfaced by start()'s rejection; only recover from errors once actually listening.
        if (!this.isListening) {
            return;
        }
        this.isListening = false;
        this.serverBaseUrl = undefined;

        const restart = l10n.t('Restart');
        const reloadWindow = l10n.t('Reload Window');

        void window
            .showErrorMessage(
                l10n.t(
                    'The Deepnote integrations service stopped unexpectedly. Integration environment variables will not update until it restarts.'
                ),
                restart,
                reloadWindow
            )
            .then((choice) => {
                if (choice === restart) {
                    this.restart();
                } else if (choice === reloadWindow) {
                    void commands.executeCommand('workbench.action.reloadWindow');
                }
            });
    }

    private restart(): void {
        this.stop();
        this.startAttempt = this.start().catch((err) =>
            logger.error('UserpodApiEndpoints: Failed to restart integration env vars endpoint', err)
        );
    }

    private async start(): Promise<void> {
        const app: Express = express();

        app.get('/userpod-api/:projectId/integrations/environment-variables', async (req: Request, res: Response) => {
            try {
                // The `:projectId` route segment is always a single value at runtime; narrow the over-broad express type.
                const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;

                if (!this.isAuthorized(req.headers.authorization, projectId)) {
                    res.status(401).json([]);

                    return;
                }

                // Filter (not find): sibling `.deepnote` files can share a project id, so serve the project's env
                // vars rather than an arbitrary first match, merged deterministically by notebook uri.
                const notebooks = workspace.notebookDocuments.filter(
                    (nb) => nb.notebookType === DEEPNOTE_NOTEBOOK_TYPE && nb.metadata?.deepnoteProjectId === projectId
                );

                if (notebooks.length === 0) {
                    res.json([]);

                    return;
                }

                if (notebooks.length > 1) {
                    logger.warn(
                        `UserpodApiEndpoints: ${notebooks.length} open notebooks share project '${projectId}'; merging their integration env vars.`
                    );
                }

                const ordered = [...notebooks].sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()));
                const resolved = await Promise.all(
                    ordered.map((notebook) => this.sqlIntegrationEnvVarsProvider.getEnvironmentVariables(notebook.uri))
                );

                const merged = new Map<string, string | undefined>();
                for (const envVars of resolved) {
                    for (const [name, value] of Object.entries(envVars ?? {})) {
                        if (!merged.has(name)) {
                            merged.set(name, value);
                        }
                    }
                }

                const payload = [...merged].map(([name, value]) => ({ name, value }));

                res.json(payload);
            } catch (err) {
                logger.error('UserpodApiEndpoints: Failed to resolve integration environment variables', err);
                res.status(500).send('Failed to resolve integration environment variables');
            }
        });

        const server = http.createServer(app);
        this.server = server;

        // Persistent handler: an 'error' with no listener is re-thrown as an uncaught exception that crashes the host.
        server.on('error', (err) => this.onServerError(err));

        server.listen(0, '127.0.0.1');

        const port = await new Promise<number>((resolve, reject) => {
            let onStartupError: (err: Error) => void = () => undefined;
            let onListening: () => void = () => undefined;
            onStartupError = (err: Error) => {
                server.removeListener('listening', onListening);
                reject(err);
            };
            onListening = () => {
                server.removeListener('error', onStartupError);
                const address = server.address();
                if (!address || typeof address === 'string') {
                    reject(new Error('Integration env vars endpoint did not bind a port.'));

                    return;
                }
                this.isListening = true;
                resolve(address.port);
            };
            server.once('error', onStartupError);
            server.once('listening', onListening);
        });

        this.serverBaseUrl = `http://127.0.0.1:${port}`;
        logger.info(`UserpodApiEndpoints: Listening on ${this.serverBaseUrl}`);
    }

    private stop(): void {
        const server = this.server;
        this.server = undefined;
        this.serverBaseUrl = undefined;
        this.isListening = false;
        if (!server) {
            return;
        }

        try {
            server.closeAllConnections();
            server.close();
        } catch (err) {
            logger.warn('UserpodApiEndpoints: Error while stopping server', err);
        }
    }
}
