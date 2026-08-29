import * as fs from 'fs';
import * as vscode from 'vscode';
import { CancellationError } from 'vscode';
import { inject, injectable } from 'inversify';
import type {
    LanguageClient as LanguageClientType,
    LanguageClientOptions,
    Executable,
    ServerOptions
} from 'vscode-languageclient/node';

// The bundled module uses ESM default export, so we need to access .default
// eslint-disable-next-line @typescript-eslint/no-require-imports
const languageClientModule = require('vscode-languageclient/node');
const { LanguageClient, TransportKind, RevealOutputChannelOn, State } = (languageClientModule.default ??
    languageClientModule) as typeof import('vscode-languageclient/node');

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposable, IDisposableRegistry } from '../../platform/common/types';
import * as path from '../../platform/vscode-path/path';
import { IDeepnoteLspClientManager } from './types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { logger } from '../../platform/logging';
import { getNotebookKey } from '../../platform/deepnote/deepnoteProjectUtils';
import { noop } from '../../platform/common/utils/misc';
import {
    IPlatformNotebookEditorProvider,
    IPlatformDeepnoteNotebookManager,
    ISqlIntegrationEnvVarsProvider
} from '../../platform/notebooks/deepnote/types';
import { SqlLspConnection, isSupportedBySqlLsp, convertToSqlLspConnection } from './sqlLspConnectionUtils';

interface LspClientInfo {
    pythonClient?: LanguageClientType;
    // Note: SQL client is now shared globally, not per-notebook
}

const sqlLintRules = {} as const;

// Global shared SQL LSP client to prevent "command already exists" errors
// The SQL language server registers commands globally, so we can only have one client
let sharedSqlClient: LanguageClientType | undefined;
let sharedSqlClientRefCount = 0;
let sharedSqlClientStarting = false;
/** Connections the shared client is currently pointed at, so a reconfigure can skip a no-op switch. */
let sharedSqlConnections: SqlLspConnection[] = [];

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
        @inject(IPlatformNotebookEditorProvider)
        private readonly notebookEditorProvider: IPlatformNotebookEditorProvider,
        @inject(IPlatformDeepnoteNotebookManager) private readonly notebookManager: IPlatformDeepnoteNotebookManager,
        @inject(ISqlIntegrationEnvVarsProvider)
        private readonly sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider
    ) {
        this.disposables.push(this);
    }

    public activate(): void {
        logger.info('DeepnoteLspClientManager activated');
    }

    public async startLspClients(
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

        const notebookKey = getNotebookKey(notebookUri);

        const pendingStart = this.pendingStarts.get(notebookKey);

        if (pendingStart) {
            logger.trace(`LSP client is already starting up for ${notebookKey}.`);

            return;
        }

        const existing = this.clients.get(notebookKey);

        // `state` rather than mere presence: vscode-languageclient restarts a crashed server on the
        // same instance (5 times in 3 minutes), so a client that is merely recovering must be left
        // alone. Note that a client part-way through its own stop() also reads as Stopped, which is
        // why stopLspClients only removes the entry it started with.
        if (existing?.pythonClient && existing.pythonClient.state !== State.Stopped) {
            logger.trace(`LSP clients already started for ${notebookKey}.`);

            return;
        }

        logger.info(`Starting LSP clients for ${notebookKey} using interpreter ${interpreter.uri.fsPath}.`);

        // Claimed before the first await below, so a second caller arriving while a dead client is
        // being replaced is turned away by the pending check rather than replacing it a second time.
        this.pendingStarts.set(notebookKey, true);

        try {
            if (existing) {
                logger.warn(`Replacing a stopped Python LSP client for ${notebookKey}`);
                this.clients.delete(notebookKey);
                this.releaseSharedSqlClient();
                await existing.pythonClient?.dispose().catch(noop);
            }

            if (token?.isCancellationRequested) {
                return;
            }

            const pythonClient = await this.createPythonLspClient(notebookUri, interpreter, token);

            if (token?.isCancellationRequested) {
                await pythonClient.stop();
                await pythonClient.dispose();

                return;
            }

            // Use the shared SQL LSP client (only one can exist due to global command registration)
            try {
                await this.ensureSharedSqlClient(notebookUri, token);
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

                this.releaseSharedSqlClient();

                return;
            }

            const clientInfo: LspClientInfo = {
                pythonClient
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
        const notebookKey = getNotebookKey(notebookUri);
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

        // Only if it is still the client this call set out to stop: a stopping client already reads
        // as Stopped, so a start that ran while the teardown above was awaited may have replaced the
        // entry. Deleting unconditionally would drop that live client and leak its process. The SQL
        // reference goes with the entry, so whichever call removes it is the one that releases.
        if (this.clients.get(notebookKey) === clientInfo) {
            this.clients.delete(notebookKey);
            this.releaseSharedSqlClient();
        }

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
        }

        await Promise.all(stopPromises);
        this.clients.clear();

        // Force stop the shared SQL client when stopping all clients
        await this.forceStopSharedSqlClient();
    }

    public dispose(): void {
        this.disposed = true;

        void this.stopAllClients();
    }

    /**
     * Ensures the shared SQL LSP client is running.
     * Creates it if needed, otherwise increments the reference count.
     */
    private async ensureSharedSqlClient(notebookUri: vscode.Uri, token?: vscode.CancellationToken): Promise<void> {
        // If client already exists, just increment ref count
        // Same liveness rule as the Python client: a stopped client can never be started again, so
        // drop it and fall through to creating its replacement. Resets mirror forceStopSharedSqlClient.
        if (sharedSqlClient && sharedSqlClient.state === State.Stopped) {
            logger.warn('Replacing a stopped shared SQL LSP client');
            await sharedSqlClient.dispose().catch(noop);
            sharedSqlClient = undefined;
            sharedSqlClientRefCount = 0;
            sharedSqlConnections = [];
        }

        if (sharedSqlClient) {
            sharedSqlClientRefCount++;
            logger.trace(`Reusing shared SQL LSP client, ref count: ${sharedSqlClientRefCount}`);

            await this.reconfigureSharedSqlClient(sharedSqlClient, notebookUri);

            return;
        }

        // If another call is already starting the client, wait for it
        if (sharedSqlClientStarting) {
            logger.trace('Waiting for shared SQL LSP client to start...');
            // Wait for the client to be created by polling
            const startTime = Date.now();
            while (sharedSqlClientStarting && Date.now() - startTime < 30000) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                if (token?.isCancellationRequested) {
                    throw new CancellationError();
                }
            }
            if (sharedSqlClient) {
                sharedSqlClientRefCount++;

                await this.reconfigureSharedSqlClient(sharedSqlClient, notebookUri);

                return;
            }
            throw new Error('Shared SQL LSP client failed to start');
        }

        // Create the shared client
        sharedSqlClientStarting = true;
        try {
            sharedSqlClient = await this.createSqlLspClient(notebookUri, token);
            sharedSqlClientRefCount = 1;
            logger.info('Shared SQL LSP client created successfully');
        } finally {
            sharedSqlClientStarting = false;
        }
    }

    /**
     * Points the shared client at this notebook's connections. The server holds one active connection globally, so a
     * client this notebook did not start is still aimed at whichever notebook did — without this, this notebook gets
     * the other one's schema completions. Called from both reuse paths, since a notebook that waited out someone
     * else's startup is in exactly the same position as one that arrived after it.
     *
     * Best-effort: a failed reconfigure leaves stale completions, which must not fail the reuse itself.
     */
    private async reconfigureSharedSqlClient(client: LanguageClientType, notebookUri: vscode.Uri): Promise<void> {
        try {
            await this.applySqlConnections(client, await this.getSqlConnections(notebookUri));
        } catch (error) {
            logger.warn(
                `SQL LSP: failed to reconfigure the shared client for ${notebookUri.toString()}; completions may reflect another notebook.`,
                error
            );
        }
    }

    /**
     * Releases a reference to the shared SQL LSP client.
     * Does not actually stop the client - it stays alive for other notebooks.
     */
    private releaseSharedSqlClient(): void {
        if (sharedSqlClientRefCount > 0) {
            sharedSqlClientRefCount--;
            logger.trace(`Released shared SQL LSP client reference, ref count: ${sharedSqlClientRefCount}`);
        }
    }

    /**
     * Force stops the shared SQL LSP client, regardless of reference count.
     * Used when stopping all clients or disposing.
     */
    private async forceStopSharedSqlClient(): Promise<void> {
        if (sharedSqlClient) {
            try {
                logger.info('Force stopping shared SQL LSP client');
                await sharedSqlClient.stop();
                await sharedSqlClient.dispose();
            } catch (error) {
                logger.error('Error stopping shared SQL client:', error);
            } finally {
                sharedSqlClient = undefined;
                sharedSqlClientRefCount = 0;
                // A fresh client must be configured from scratch; a stale value here would skip that as a no-op.
                sharedSqlConnections = [];
            }
        }
    }

    private async createPythonLspClient(
        notebookUri: vscode.Uri,
        interpreter: PythonEnvironment,
        token?: vscode.CancellationToken
    ): Promise<LanguageClientType> {
        // Check cancellation before creating client
        if (token?.isCancellationRequested) {
            throw new CancellationError();
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

        // Use a unique client ID per notebook to prevent conflicts when multiple LSP clients exist
        const clientId = `deepnote-python-lsp-${getNotebookKey(notebookUri)}`;
        const client = new LanguageClient(clientId, 'Deepnote Python Language Server', serverOptions, clientOptions);

        // Check cancellation before starting client
        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }

        await client.start();

        logger.info(`Python LSP client started for ${notebookUri.toString()}`);

        return client;
    }

    /**
     * Points the shared SQL server at `connections` and triggers a schema refetch. Used both at creation and when
     * another notebook reuses the client, so the two paths cannot drift.
     */
    private async applySqlConnections(
        client: LanguageClientType,
        connections: SqlLspConnection[],
        outputChannel?: vscode.OutputChannel
    ): Promise<void> {
        if (JSON.stringify(connections) === JSON.stringify(sharedSqlConnections)) {
            return;
        }

        // The server ignores an empty list, so the previously loaded schema stays until some notebook supplies
        // connections again. Clearing it would need a restart, which the global command registration rules out.
        if (connections.length === 0) {
            logger.trace('SQL LSP: no connections for this notebook; leaving the server configured as-is');

            return;
        }

        // The server's onDidChangeConfiguration handler processes this and connects to the database.
        await client.sendNotification('workspace/didChangeConfiguration', {
            settings: {
                sqlLanguageServer: {
                    connections: connections,
                    lint: { rules: sqlLintRules }
                }
            }
        });

        // Explicitly switch to the first connection so the schema is fetched and errors are properly reported.
        try {
            await client.sendRequest('workspace/executeCommand', {
                command: 'sqlLanguageServer.switchDatabaseConnection',
                arguments: [connections[0].name]
            });
        } catch (error) {
            outputChannel?.appendLine(`[SQL LSP] Failed to switch connection: ${error}`);
            logger.warn(`SQL LSP: Failed to switch to connection ${connections[0].name}:`, error);
        }

        sharedSqlConnections = connections;
    }

    private async createSqlLspClient(
        notebookUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<LanguageClientType> {
        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }

        logger.trace(`Creating SQL LSP client for ${notebookUri.toString()}`);

        const serverModule = this.getSqlLanguageServerModule();
        const connections = await this.getSqlConnections(notebookUri);

        const outputChannel = vscode.window.createOutputChannel('Deepnote SQL LSP');

        const connectionSummary = connections.map((c) => `${c.name} (${c.adapter})`).join(', ');

        outputChannel.appendLine(
            `[SQL LSP] Starting with ${connections.length} connection(s): ${connectionSummary || 'none'}`
        );
        logger.info(`Starting SQL LSP with ${connections.length} database connection(s)`);

        // Use IPC transport - must match the server's hardcoded 'node-ipc' method
        // Set NODE_PATH to include the sql-lsp-modules directory for runtime dependencies
        const sqlLspModulesPath = this.getSqlLspModulesPath();
        const nodePathEnv = sqlLspModulesPath ? { NODE_PATH: sqlLspModulesPath } : {};

        const serverOptions: ServerOptions = {
            run: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: { env: { ...process.env, ...nodePathEnv } }
            },
            debug: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: { execArgv: ['--nolazy', '--inspect=6009'], env: { ...process.env, ...nodePathEnv } }
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
                                // Prefer the live value over the creation-time capture, so a reconfigure is not
                                // undone by a later pull. It is still empty during the initial pull, which
                                // happens before the first push — fall back to this client's own connections.
                                result.push({
                                    connections: sharedSqlConnections.length > 0 ? sharedSqlConnections : connections
                                });
                            } else {
                                result.push(await next(params, _token));
                            }
                        }

                        return result.length === 1 ? result[0] : result;
                    }
                }
            }
        };

        // Use a static client ID since there's only one shared SQL LSP client
        // (The SQL server registers commands globally, so only one instance can exist)
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

            outputChannel.appendLine(`[SQL LSP] Setup complete - connected to: ${connectedTo}`);
            outputChannel.appendLine(`[SQL LSP] Available connections: ${availableConnections.join(', ') || 'none'}`);

            logger.info(`SQL LSP connected to database: ${connectedTo}, available: ${availableConnections.join(', ')}`);
        });

        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }

        await client.start();

        await this.applySqlConnections(client, connections, outputChannel);

        logger.info(`SQL LSP client started and ready for ${notebookUri.toString()}`);

        return client;
    }

    /**
     * Get the path to sql-language-server VS Code extension server module
     * @returns Path to the vscodeExtensionServer.js module for IPC transport
     */
    private getSqlLanguageServerModule(): string {
        // Try require.resolve first - this handles different package layouts (works in dev mode)
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const serverModule = require.resolve('@deepnote/sql-language-server/dist/bin/vscodeExtensionServer.js');

            logger.trace('SQL LSP server module resolved via require.resolve:', serverModule);

            return serverModule;
        } catch (error) {
            logger.trace('require.resolve failed, falling back to path construction:', error);
        }

        // Fallback: use extension path construction (works in packaged extension)
        // The sql-language-server is bundled into dist/sqlLanguageServer.cjs during build
        let extensionPath = vscode.extensions.getExtension('Deepnote.vscode-deepnote')?.extensionPath;

        if (!extensionPath) {
            // This file is in src/kernels/deepnote/, so go up 3 levels to get to root
            extensionPath = path.join(__dirname, '..', '..', '..');
            logger.trace('Using __dirname to find extension path:', extensionPath);
        }

        const serverModule = path.join(extensionPath, 'dist', 'sqlLanguageServer.cjs');
        logger.trace('SQL LSP server module (fallback):', serverModule);

        return serverModule;
    }

    /**
     * Get the path to the sql-lsp-modules directory containing runtime dependencies
     * @returns Path to the node_modules directory for SQL LSP, or undefined if not found
     */
    private getSqlLspModulesPath(): string | undefined {
        let extensionPath = vscode.extensions.getExtension('Deepnote.vscode-deepnote')?.extensionPath;

        if (!extensionPath) {
            extensionPath = path.join(__dirname, '..', '..', '..');
        }

        const modulesPath = path.join(extensionPath, 'dist', 'sql-lsp-modules', 'node_modules');

        // Return undefined if the directory doesn't exist
        if (!fs.existsSync(modulesPath)) {
            return undefined;
        }

        return modulesPath;
    }

    /**
     * Get SQL connections configuration from integration storage for the current project.
     * Only returns integrations that are configured for the specific project.
     * @param notebookUri The notebook URI to get project-scoped integrations for
     * @returns Array of connection configurations for sql-language-server
     */
    private async getSqlConnections(notebookUri: vscode.Uri): Promise<SqlLspConnection[]> {
        try {
            const notebook = this.notebookEditorProvider.findAssociatedNotebookDocument(notebookUri);

            if (!notebook) {
                logger.warn('SQL LSP: No notebook found for URI');
                return [];
            }

            const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
            const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;

            if (!projectId || !notebookId) {
                logger.warn('SQL LSP: No project/notebook ID in notebook metadata');
                return [];
            }

            const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);

            if (!project) {
                logger.warn(`SQL LSP: No project found for ID: ${projectId}`);
                return [];
            }

            const projectIntegrations = project.project.integrations?.slice() ?? [];

            logger.trace(`SQL LSP: Found ${projectIntegrations.length} integrations in project ${projectId}`);

            // Merged (SecretStorage + `.deepnote.env.yaml`) configs, so file-configured databases also get
            // LSP autocomplete/schema.
            const projectIntegrationConfigs = (
                await this.sqlIntegrationEnvVars.getMergedIntegrationConfigs(notebookUri)
            ).filter((config) => config.type !== 'pandas-dataframe');

            const connections = projectIntegrationConfigs
                .filter((config) => isSupportedBySqlLsp(config.type))
                .map((config) => convertToSqlLspConnection(config))
                .filter((conn) => conn !== null);

            logger.trace(
                `SQL LSP: Found ${connections.length} SQL LSP-compatible integrations for project ${projectId}`
            );

            return connections;
        } catch (error) {
            logger.warn('Failed to get SQL connections from integration storage:', error);

            return [];
        }
    }
}
