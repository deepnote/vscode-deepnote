import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';
import { inject, injectable } from 'inversify';
import { type AddressInfo } from 'net';
import { workspace } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { IIntegrationsEnvVarsEndpoint } from './types';

/**
 * Loopback HTTP endpoint the Deepnote toolkit reads integration environment variables from. The toolkit's
 * `set_integration_env()` GETs `/userpod-api/:projectId/integrations/environment-variables` at kernel start
 * (and again on every live refresh) and applies the returned `[{ name, value }]` array to the kernel process.
 * Bound to `127.0.0.1` only, so no auth is needed.
 */
@injectable()
export class IntegrationsEnvVarsEndpoint implements IIntegrationsEnvVarsEndpoint, IExtensionSyncActivationService {
    private server: http.Server | undefined;
    private startedBaseUrl: string | undefined;

    constructor(
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVarsProvider: ISqlIntegrationEnvVarsProvider,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public get baseUrl(): string | undefined {
        return this.startedBaseUrl;
    }

    public activate(): void {
        // Start listening at activation so the endpoint is ready before any kernel (and the toolkit) starts.
        this.start().catch((err) =>
            logger.error('IntegrationsEnvVarsEndpoint: Failed to start integration env vars endpoint', err)
        );
    }

    private async start(): Promise<void> {
        const app: Express = express();

        app.get('/userpod-api/:projectId/integrations/environment-variables', async (req: Request, res: Response) => {
            try {
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
                logger.error('IntegrationsEnvVarsEndpoint: Failed to resolve integration environment variables', err);
                res.status(500).json([]);
            }
        });

        const server = http.createServer(app);
        this.server = server;

        // Tear the server down on extension shutdown.
        this.disposables.push({ dispose: () => this.stop() });

        server.listen(0, '127.0.0.1');

        const port = await new Promise<number>((resolve, reject) => {
            // Forward-declared with `let` so each handler can `removeListener` the other (avoids use-before-define).
            let onError: (err: Error) => void = () => undefined;
            let onListening: () => void = () => undefined;
            onError = (err: Error) => {
                server.removeListener('listening', onListening);
                reject(err);
            };
            onListening = () => {
                server.removeListener('error', onError);
                const address = server.address() as AddressInfo | null;
                if (!address || typeof address === 'string') {
                    reject(new Error('Integration env vars endpoint did not bind a port.'));

                    return;
                }
                resolve(address.port);
            };
            server.once('error', onError);
            server.once('listening', onListening);
        });

        this.startedBaseUrl = `http://127.0.0.1:${port}`;
        logger.info(`IntegrationsEnvVarsEndpoint: Listening on ${this.startedBaseUrl}`);
    }

    private stop(): void {
        const server = this.server;
        if (!server) {
            return;
        }
        this.server = undefined;
        this.startedBaseUrl = undefined;

        // `closeAllConnections` prevents the server hanging on a half-open TCP connection at shutdown.
        if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
            (server as { closeAllConnections: () => void }).closeAllConnections();
        }
        server.close();
    }
}
