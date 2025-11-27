import * as vscode from 'vscode';
import { inject, injectable } from 'inversify';
import { createRequire } from 'module';
import type {
    LanguageClient as LanguageClientType,
    LanguageClientOptions,
    Executable,
    ServerOptions
} from 'vscode-languageclient/node';

// Use createRequire for ESM compatibility with vscode-languageclient
// The bundled module uses ESM default export, so we need to access .default
const require = createRequire(import.meta.url);
const languageClientModule = require('vscode-languageclient/node');
const { LanguageClient, TransportKind, RevealOutputChannelOn } = (languageClientModule.default ??
    languageClientModule) as typeof import('vscode-languageclient/node');

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposable, IDisposableRegistry } from '../../platform/common/types';
import * as path from '../../platform/vscode-path/path';
import { DeepnoteServerInfo, IDeepnoteLspClientManager } from './types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { logger } from '../../platform/logging';
import { noop } from '../../platform/common/utils/misc';
import { IIntegrationStorage } from '../../platform/notebooks/deepnote/types';
import { SqlLspConnection, isSupportedBySqlLsp, convertToSqlLspConnection } from './sqlLspConnectionUtils';

interface LspClientInfo {
    pythonClient?: LanguageClientType;
    sqlClient?: LanguageClientType;
}

const sqlLintRules = {} as const;

export { SqlLspConnection, supportedSqlLspTypes } from './sqlLspConnectionUtils';

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

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage
    ) {
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
                await pythonClient.stop();
                await pythonClient.dispose();

                return;
            }

            let sqlClient: LanguageClientType | undefined;

            try {
                sqlClient = await this.createSqlLspClient(notebookUri, token);

                logger.info(`SQL LSP client started successfully for ${notebookKey}`);
            } catch (error) {
                logger.warn(
                    `Failed to start SQL LSP client for ${notebookKey}. ` +
                        `SQL language features will not be available. ` +
                        `Ensure sql-language-server is installed and database integrations are configured.`,
                    error
                );
            }

            if (token?.isCancellationRequested) {
                await pythonClient.stop();
                await pythonClient.dispose();

                if (sqlClient) {
                    await sqlClient.stop();
                    await sqlClient.dispose();
                }
                return;
            }

            const clientInfo: LspClientInfo = {
                pythonClient,
                sqlClient
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
    ): Promise<LanguageClientType> {
        // Check cancellation before creating client
        if (token?.isCancellationRequested) {
            throw new Error('Operation cancelled');
        }

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

    private async createSqlLspClient(
        notebookUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<LanguageClientType> {
        if (token?.isCancellationRequested) {
            throw new Error('Operation cancelled');
        }

        logger.trace(`Creating SQL LSP client for ${notebookUri.toString()}`);

        const serverModule = this.getSqlLanguageServerModule();
        const connections = await this.getSqlConnections(notebookUri);

        logger.info(`Starting SQL LSP with ${connections.length} database connection(s)`);

        const outputChannel = vscode.window.createOutputChannel('Deepnote SQL LSP');

        const serverOptions: ServerOptions = {
            run: { module: serverModule, transport: TransportKind.ipc },
            debug: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: { execArgv: ['--nolazy', '--inspect=6009'] }
            }
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                {
                    scheme: 'vscode-notebook-cell',
                    language: 'sql',
                    pattern: '**/*.deepnote'
                },
                {
                    scheme: 'file',
                    language: 'sql',
                    pattern: '**/*.deepnote'
                }
            ],
            // Match the official extension's configuration
            // https://github.com/deeppnote/sql-language-server/blob/release/packages/client/extension.ts
            diagnosticCollectionName: 'sqlLanguageServer',
            synchronize: {
                configurationSection: 'sqlLanguageServer'
            },
            outputChannel: outputChannel,
            revealOutputChannelOn: RevealOutputChannelOn.Info,
            initializationOptions: {
                connections: connections,
                lint: { rules: sqlLintRules }
            },
            markdown: {
                isTrusted: true,
                supportHtml: true
            },
            middleware: {
                provideCompletionItem: async (document, position, context, token, next) => {
                    const result = await next(document, position, context, token);

                    if (!result) {
                        return result;
                    }

                    // Handle both CompletionList and CompletionItem[] formats
                    const items = Array.isArray(result) ? result : result.items;

                    // Fix completion items that incorrectly add "AS <alias>" suffix
                    // sql-language-server sometimes adds aliases based on what the user typed
                    for (const item of items) {
                        if (typeof item.insertText === 'string') {
                            // Remove "AS <alias>" suffix pattern from insert text
                            item.insertText = item.insertText.replace(/\s+AS\s+\w+$/i, '');
                        }

                        if (item.textEdit && 'newText' in item.textEdit) {
                            // Remove "AS <alias>" suffix pattern from text edit
                            item.textEdit.newText = item.textEdit.newText.replace(/\s+AS\s+\w+$/i, '');
                        }
                    }

                    return result;
                },
                workspace: {
                    configuration: async (params, _token, next) => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const result: any[] = [];

                        for (const item of params.items) {
                            if (item.section === 'sqlLanguageServer') {
                                result.push({ connections: connections });
                            } else {
                                result.push(await next(params, _token));
                            }
                        }

                        return result.length === 1 ? result[0] : result;
                    }
                }
            }
        };

        const client = new LanguageClient(
            'deepnote-sql-lsp',
            'Deepnote SQL Language Server',
            serverOptions,
            clientOptions
        );

        client.onNotification('sqlLanguageServer.error', (params: { message: string }) => {
            outputChannel.appendLine(`[SQL LSP Error] ${params.message}`);
            logger.warn(`SQL LSP server error: ${params.message}`);
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.onNotification('sqlLanguageServer.finishSetup', (params: any) => {
            const connectedTo = params.config?.name || 'unknown';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const availableConnections = params.personalConfig?.connections?.map((c: any) => c.name) || [];
            outputChannel.appendLine(`[SQL LSP] Connected to: ${connectedTo}`);
            logger.info(`SQL LSP connected to database: ${connectedTo}, available: ${availableConnections.join(', ')}`);
        });

        if (token?.isCancellationRequested) {
            throw new Error('Operation cancelled');
        }

        await client.start();

        // Send configuration change notification to trigger schema loading
        // The server's onDidChangeConfiguration handler processes this and connects to the database
        await client.sendNotification('workspace/didChangeConfiguration', {
            settings: {
                sqlLanguageServer: {
                    connections: connections,
                    lint: { rules: sqlLintRules }
                }
            }
        });

        logger.info(`SQL LSP client started and ready for ${notebookUri.toString()}`);

        return client;
    }

    /**
     * Get the path to sql-language-server VS Code extension server module
     * @returns Path to the vscodeExtensionServer.js module for IPC transport
     */
    private getSqlLanguageServerModule(): string {
        // Try to get extension path from registered extension first
        let extensionPath = vscode.extensions.getExtension('Deepnote.vscode-deepnote')?.extensionPath;

        // Fallback: use __dirname to find the extension root
        // In development, the extension might not be registered yet
        if (!extensionPath) {
            // This file is in src/kernels/deepnote/, so go up 3 levels to get to root
            extensionPath = path.join(__dirname, '..', '..', '..');
            logger.trace('Using __dirname to find extension path:', extensionPath);
        }

        // Path to the VS Code extension server module (uses IPC, not CLI stdio)
        const serverModule = path.join(
            extensionPath,
            'node_modules',
            'sql-language-server',
            'dist',
            'vscodeExtensionServer.js'
        );
        logger.trace('SQL LSP server module:', serverModule);

        return serverModule;
    }

    /**
     * Get SQL connections configuration from integration storage
     * Converts extension's integration configs to sql-language-server format
     * @param notebookUri The notebook URI (used for potential future project-scoped integrations)
     * @returns Array of connection configurations for sql-language-server
     */
    private async getSqlConnections(_notebookUri: vscode.Uri): Promise<SqlLspConnection[]> {
        try {
            const integrations = await this.integrationStorage.getAll();

            const connections = integrations
                .filter((config) => isSupportedBySqlLsp(config.type))
                .map((config) => convertToSqlLspConnection(config))
                .filter((conn): conn is SqlLspConnection => conn !== null);

            logger.trace(
                `Found ${connections.length} SQL LSP-compatible integrations out of ${integrations.length} total`
            );

            return connections;
        } catch (error) {
            logger.warn('Failed to get SQL connections from integration storage:', error);

            return [];
        }
    }
}
