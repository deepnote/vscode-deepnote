import * as vscode from 'vscode';
import { inject, injectable } from 'inversify';
import type { LanguageClient, LanguageClientOptions, Executable } from 'vscode-languageclient/node';

import { IDisposable, IDisposableRegistry } from '../../platform/common/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { DeepnoteServerInfo, IDeepnoteLspClientManager } from './types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { logger } from '../../platform/logging';
import { noop } from '../../platform/common/utils/misc';

interface LspClientInfo {
    pythonClient?: LanguageClient;
    sqlClient?: LanguageClient;
}

/**
 * Manages LSP client connections to Deepnote Toolkit's language servers.
 * Creates and manages Python and SQL LSP clients for code intelligence.
 */
@injectable()
export class DeepnoteLspClientManager
    implements IDeepnoteLspClientManager, IExtensionSyncActivationService, IDisposable
{
    private readonly clients = new Map<string, LspClientInfo>();
    private readonly pendingStarts = new Map<string, boolean>();

    private disposed = false;

    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {
        this.disposables.push(this);
    }

    public activate(): void {
        logger.info('DeepnoteLspClientManager activated');
    }

    public async startLspClients(
        _serverInfo: DeepnoteServerInfo,
        notebookUri: vscode.Uri,
        interpreter: PythonEnvironment,
        token?: vscode.CancellationToken
    ): Promise<void> {
        if (this.disposed) {
            return;
        }

        if (token?.isCancellationRequested) {
            return;
        }

        const notebookKey = notebookUri.toString();

        const pendingStart = this.pendingStarts.get(notebookKey);

        if (pendingStart) {
            logger.trace(`LSP client is already starting up for ${notebookKey}.`);

            return;
        }

        if (this.clients.has(notebookKey)) {
            logger.trace(`LSP clients already started for ${notebookKey}.`);

            return;
        }

        logger.info(`Starting LSP clients for ${notebookKey} using interpreter ${interpreter.uri.fsPath}.`);

        this.pendingStarts.set(notebookKey, true);

        try {
            if (token?.isCancellationRequested) {
                return;
            }

            const pythonClient = await this.createPythonLspClient(notebookUri, interpreter, token);

            if (token?.isCancellationRequested) {
                // Clean up the client if cancellation occurred after creation
                await pythonClient.stop();
                await pythonClient.dispose();
                return;
            }

            const clientInfo: LspClientInfo = {
                pythonClient
                // TODO: Add SQL client when endpoint is determined
            };

            this.clients.set(notebookKey, clientInfo);

            logger.info(`LSP clients started successfully for ${notebookKey}`);
        } catch (error) {
            logger.error(`Failed to start LSP clients for ${notebookKey}:`, error);

            throw error;
        } finally {
            this.pendingStarts.delete(notebookKey);
        }
    }

    public async stopLspClients(notebookUri: vscode.Uri, token?: vscode.CancellationToken): Promise<void> {
        const notebookKey = notebookUri.toString();
        const clientInfo = this.clients.get(notebookKey);

        if (!clientInfo) {
            return;
        }

        // Check cancellation before stopping
        if (token?.isCancellationRequested) {
            return;
        }

        logger.info(`Stopping LSP clients for ${notebookKey}`);

        // Stop all clients without intermediate cancellation checks to ensure complete cleanup
        if (clientInfo.pythonClient) {
            try {
                await clientInfo.pythonClient.stop();
                await clientInfo.pythonClient.dispose();
            } catch (error) {
                logger.error(`Error stopping Python client for ${notebookKey}:`, error);
            }
        }

        if (clientInfo.sqlClient) {
            try {
                await clientInfo.sqlClient.stop();
                await clientInfo.sqlClient.dispose();
            } catch (error) {
                logger.error(`Error stopping SQL client for ${notebookKey}:`, error);
            }
        }

        this.clients.delete(notebookKey);

        logger.info(`LSP clients stopped for ${notebookKey}`);
    }

    public async stopAllClients(token?: vscode.CancellationToken): Promise<void> {
        // Check cancellation before stopping
        if (token?.isCancellationRequested) {
            return;
        }

        logger.info('Stopping all LSP clients');

        const stopPromises: Promise<void>[] = [];
        for (const [, clientInfo] of this.clients.entries()) {
            // Check cancellation during iteration
            if (token?.isCancellationRequested) {
                break;
            }

            if (clientInfo.pythonClient) {
                // Chain stop() and dispose() sequentially for each client
                stopPromises.push(
                    clientInfo.pythonClient
                        .stop()
                        .catch(noop)
                        .then(() => clientInfo.pythonClient!.dispose().catch(noop))
                );
            }

            if (clientInfo.sqlClient) {
                // Chain stop() and dispose() sequentially for each client
                stopPromises.push(
                    clientInfo.sqlClient
                        .stop()
                        .catch(noop)
                        .then(() => clientInfo.sqlClient!.dispose().catch(noop))
                );
            }
        }

        await Promise.all(stopPromises);
        this.clients.clear();
    }

    public dispose(): void {
        this.disposed = true;

        void this.stopAllClients();
    }

    private async createPythonLspClient(
        notebookUri: vscode.Uri,
        interpreter: PythonEnvironment,
        token?: vscode.CancellationToken
    ): Promise<LanguageClient> {
        // Check cancellation before creating client
        if (token?.isCancellationRequested) {
            throw new Error('Operation cancelled');
        }

        // Dynamically import vscode-languageclient to avoid bundling issues
        const { LanguageClient } = await import('vscode-languageclient/node');

        const pythonPath = interpreter.uri.fsPath;

        logger.trace(`Creating Python LSP client using interpreter: ${pythonPath}`);

        const serverOptions: Executable = {
            command: pythonPath,
            args: ['-m', 'pylsp'], // Start python-lsp-server
            options: {
                env: { ...process.env }
            }
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                {
                    scheme: 'vscode-notebook-cell',
                    language: 'python',
                    pattern: '**/*.deepnote'
                },
                {
                    scheme: 'file',
                    language: 'python',
                    pattern: '**/*.deepnote'
                }
            ],
            synchronize: {
                fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{py,deepnote}')
            },
            outputChannelName: 'Deepnote Python LSP'
        };

        const client = new LanguageClient(
            'deepnote-python-lsp',
            'Deepnote Python Language Server',
            serverOptions,
            clientOptions
        );

        // Check cancellation before starting client
        if (token?.isCancellationRequested) {
            throw new Error('Operation cancelled');
        }

        await client.start();

        logger.info(`Python LSP client started for ${notebookUri.toString()}`);

        return client;
    }

    // TODO: Implement SQL LSP client when endpoint information is available
    // private async createSqlLspClient(serverInfo: DeepnoteServerInfo, notebookUri: vscode.Uri): Promise<LanguageClient> {
    //     // Similar to Python client but for SQL
    // }
}
