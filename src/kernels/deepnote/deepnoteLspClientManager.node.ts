// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { inject, injectable } from 'inversify';
import { LanguageClient, LanguageClientOptions, Executable } from 'vscode-languageclient/node';
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
    // Map notebook URIs to their LSP clients
    private readonly clients = new Map<string, LspClientInfo>();
    private disposed = false;

    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {
        this.disposables.push(this);
    }

    public activate(): void {
        // This service is activated synchronously and doesn't need async initialization
        logger.info('DeepnoteLspClientManager activated');
    }

    public async startLspClients(
        _serverInfo: DeepnoteServerInfo,
        notebookUri: vscode.Uri,
        interpreter: PythonEnvironment
    ): Promise<void> {
        if (this.disposed) {
            return;
        }

        const notebookKey = notebookUri.toString();

        // Check if clients already exist for this notebook
        if (this.clients.has(notebookKey)) {
            logger.trace(`LSP clients already started for ${notebookKey}`);
            return;
        }

        logger.info(`Starting LSP clients for ${notebookKey} using interpreter ${interpreter.uri.fsPath}`);

        try {
            // Start Python LSP client
            const pythonClient = await this.createPythonLspClient(notebookUri, interpreter);

            // Store the client info
            const clientInfo: LspClientInfo = {
                pythonClient
                // TODO: Add SQL client when endpoint is determined
            };

            this.clients.set(notebookKey, clientInfo);

            logger.info(`LSP clients started successfully for ${notebookKey}`);
        } catch (error) {
            logger.error(`Failed to start LSP clients for ${notebookKey}:`, error);
            throw error;
        }
    }

    public async stopLspClients(notebookUri: vscode.Uri): Promise<void> {
        const notebookKey = notebookUri.toString();
        const clientInfo = this.clients.get(notebookKey);

        if (!clientInfo) {
            return;
        }

        logger.info(`Stopping LSP clients for ${notebookKey}`);

        try {
            // Stop Python client
            if (clientInfo.pythonClient) {
                await clientInfo.pythonClient.stop();
            }

            // Stop SQL client
            if (clientInfo.sqlClient) {
                await clientInfo.sqlClient.stop();
            }

            this.clients.delete(notebookKey);
            logger.info(`LSP clients stopped for ${notebookKey}`);
        } catch (error) {
            logger.error(`Error stopping LSP clients for ${notebookKey}:`, error);
        }
    }

    public async stopAllClients(): Promise<void> {
        logger.info('Stopping all LSP clients');

        const stopPromises: Promise<void>[] = [];
        for (const [, clientInfo] of this.clients.entries()) {
            if (clientInfo.pythonClient) {
                stopPromises.push(clientInfo.pythonClient.stop().catch(noop));
            }
            if (clientInfo.sqlClient) {
                stopPromises.push(clientInfo.sqlClient.stop().catch(noop));
            }
        }

        await Promise.all(stopPromises);
        this.clients.clear();
    }

    public dispose(): void {
        this.disposed = true;
        // Stop all clients asynchronously but don't wait
        void this.stopAllClients();
    }

    private async createPythonLspClient(
        notebookUri: vscode.Uri,
        interpreter: PythonEnvironment
    ): Promise<LanguageClient> {
        // Start python-lsp-server as a child process using stdio
        const pythonPath = interpreter.uri.fsPath;

        logger.trace(`Creating Python LSP client using interpreter: ${pythonPath}`);

        // Define the server executable
        const serverOptions: Executable = {
            command: pythonPath,
            args: ['-m', 'pylsp'], // Start python-lsp-server
            options: {
                env: { ...process.env }
            }
        };

        const clientOptions: LanguageClientOptions = {
            // Document selector for Python cells in Deepnote notebooks
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
            // Synchronization settings
            synchronize: {
                // Notify the server about file changes to '.py' files in the workspace
                fileEvents: vscode.workspace.createFileSystemWatcher('**/*.py')
            },
            // Output channel for diagnostics
            outputChannelName: 'Deepnote Python LSP'
        };

        // Create the language client with stdio connection
        const client = new LanguageClient(
            'deepnote-python-lsp',
            'Deepnote Python Language Server',
            serverOptions,
            clientOptions
        );

        // Start the client
        await client.start();
        logger.info(`Python LSP client started for ${notebookUri.toString()}`);

        return client;
    }

    // TODO: Implement SQL LSP client when endpoint information is available
    // private async createSqlLspClient(serverInfo: DeepnoteServerInfo, notebookUri: vscode.Uri): Promise<LanguageClient> {
    //     // Similar to Python client but for SQL
    // }
}
