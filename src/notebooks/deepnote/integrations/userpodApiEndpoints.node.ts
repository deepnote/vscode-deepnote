import express, { type Express, type Request, type Response } from 'express';
import * as http from 'http';
import { inject, injectable } from 'inversify';
import { type AddressInfo } from 'net';
import { workspace } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { generateUuid } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { IUserpodApiEndpoints } from './types';

/** Loopback host for the toolkit's `userpod-api` calls; currently serves integration env vars for `set_integration_env()` (as `[{name,value}]`). */
@injectable()
export class UserpodApiEndpoints implements IUserpodApiEndpoints, IExtensionSyncActivationService {
    private readonly authTokenValue = generateUuid();
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
        this.start().catch((err) =>
            logger.error('UserpodApiEndpoints: Failed to start integration env vars endpoint', err)
        );
    }

    private async start(): Promise<void> {
        const app: Express = express();

        app.get('/userpod-api/:projectId/integrations/environment-variables', async (req: Request, res: Response) => {
            try {
                // The response carries integration credentials, so require the bearer token even on loopback.
                if (req.headers.authorization !== `Bearer ${this.authTokenValue}`) {
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

        this.disposables.push({ dispose: () => this.stop() });

        server.listen(0, '127.0.0.1');

        const port = await new Promise<number>((resolve, reject) => {
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

        this.serverBaseUrl = `http://127.0.0.1:${port}`;
        logger.info(`UserpodApiEndpoints: Listening on ${this.serverBaseUrl}`);
    }

    private stop(): void {
        const server = this.server;
        if (!server) {
            return;
        }
        this.server = undefined;
        this.serverBaseUrl = undefined;

        server.closeAllConnections();
        server.close();
    }
}
