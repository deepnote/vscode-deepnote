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
    private readonly authTokenValue = generateUuid();
    private isListening = false;
    private server: http.Server | undefined;
    private serverBaseUrl: string | undefined;

    constructor(
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVarsProvider: ISqlIntegrationEnvVarsProvider,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public get authToken(): string {
        return this.authTokenValue;
    }

    public get baseUrl(): string | undefined {
        return this.serverBaseUrl;
    }

    public activate(): void {
        this.disposables.push({ dispose: () => this.stop() });
        this.start().catch((err) =>
            logger.error('UserpodApiEndpoints: Failed to start integration env vars endpoint', err)
        );
    }

    private isAuthorized(authorizationHeader: string | undefined): boolean {
        if (authorizationHeader === undefined) {
            return false;
        }

        // Constant-time compare: the response carries credentials, so don't leak the token via early-exit timing.
        const expected = Buffer.from(`Bearer ${this.authTokenValue}`);
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
        this.start().catch((err) =>
            logger.error('UserpodApiEndpoints: Failed to restart integration env vars endpoint', err)
        );
    }

    private async start(): Promise<void> {
        const app: Express = express();

        app.get('/userpod-api/:projectId/integrations/environment-variables', async (req: Request, res: Response) => {
            try {
                if (!this.isAuthorized(req.headers.authorization)) {
                    res.status(401).json([]);

                    return;
                }

                const projectId = req.params.projectId;
                const notebook = workspace.notebookDocuments.find(
                    (nb) => nb.notebookType === DEEPNOTE_NOTEBOOK_TYPE && nb.metadata?.deepnoteProjectId === projectId
                );

                if (!notebook) {
                    res.json([]);

                    return;
                }

                const envVars = await this.sqlIntegrationEnvVarsProvider.getEnvironmentVariables(notebook.uri);
                const payload = Object.entries(envVars ?? {}).map(([name, value]) => ({ name, value }));

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
