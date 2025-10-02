// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { CancellationToken, Uri } from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IDeepnoteServerStarter, IDeepnoteToolkitInstaller, DeepnoteServerInfo, DEEPNOTE_DEFAULT_PORT } from './types';
import { IProcessServiceFactory, ObservableExecutionResult } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { IOutputChannel, IDisposable, IHttpClient } from '../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { sleep } from '../../platform/common/utils/async';
import { Cancellation, raceCancellationError } from '../../platform/common/cancellation';
import getPort from 'get-port';

/**
 * Starts and manages the deepnote-toolkit Jupyter server.
 */
@injectable()
export class DeepnoteServerStarter implements IDeepnoteServerStarter {
    private readonly serverProcesses: Map<string, ObservableExecutionResult<string>> = new Map();
    private readonly serverInfos: Map<string, DeepnoteServerInfo> = new Map();
    private readonly disposablesByFile: Map<string, IDisposable[]> = new Map();
    // Track in-flight operations per file to prevent concurrent start/stop
    private readonly pendingOperations: Map<string, Promise<DeepnoteServerInfo | void>> = new Map();

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IHttpClient) private readonly httpClient: IHttpClient
    ) {}

    public async getOrStartServer(
        interpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        const fileKey = deepnoteFileUri.fsPath;

        // Wait for any pending operations on this file to complete
        const pendingOp = this.pendingOperations.get(fileKey);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on ${fileKey} to complete...`);
            try {
                await pendingOp;
            } catch {
                // Ignore errors from previous operations
            }
        }

        // If server is already running for this file, return existing info
        const existingServerInfo = this.serverInfos.get(fileKey);
        if (existingServerInfo && (await this.isServerRunning(existingServerInfo))) {
            logger.info(`Deepnote server already running at ${existingServerInfo.url} for ${fileKey}`);
            return existingServerInfo;
        }

        // Start the operation and track it
        const operation = this.startServerImpl(interpreter, deepnoteFileUri, token);
        this.pendingOperations.set(fileKey, operation);

        try {
            const result = await operation;
            return result;
        } finally {
            // Remove from pending operations when done
            if (this.pendingOperations.get(fileKey) === operation) {
                this.pendingOperations.delete(fileKey);
            }
        }
    }

    private async startServerImpl(
        interpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        const fileKey = deepnoteFileUri.fsPath;

        Cancellation.throwIfCanceled(token);

        // Ensure toolkit is installed
        logger.info(`Ensuring deepnote-toolkit is installed for ${fileKey}...`);
        const installed = await this.toolkitInstaller.ensureInstalled(interpreter, deepnoteFileUri, token);
        if (!installed) {
            throw new Error('Failed to install deepnote-toolkit. Please check the output for details.');
        }

        Cancellation.throwIfCanceled(token);

        // Find available port
        const port = await getPort({ host: 'localhost', port: DEEPNOTE_DEFAULT_PORT });
        logger.info(`Starting deepnote-toolkit server on port ${port} for ${fileKey}`);
        this.outputChannel.appendLine(`Starting Deepnote server on port ${port} for ${deepnoteFileUri.fsPath}...`);

        // Start the server
        const processService = await this.processServiceFactory.create(interpreter.uri);

        const serverProcess = processService.execObservable(interpreter.uri.fsPath, [
            '-m',
            'deepnote_toolkit',
            'server',
            '--jupyter-port',
            port.toString()
        ]);

        this.serverProcesses.set(fileKey, serverProcess);

        // Track disposables for this file
        const disposables: IDisposable[] = [];
        this.disposablesByFile.set(fileKey, disposables);

        // Monitor server output
        serverProcess.out.onDidChange(
            (output) => {
                if (output.source === 'stdout') {
                    logger.trace(`Deepnote server (${fileKey}): ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                } else if (output.source === 'stderr') {
                    logger.warn(`Deepnote server stderr (${fileKey}): ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                }
            },
            this,
            disposables
        );

        // Wait for server to be ready
        const url = `http://localhost:${port}`;
        const serverInfo = { url, port };
        this.serverInfos.set(fileKey, serverInfo);

        const serverReady = await this.waitForServer(serverInfo, 30000, token);
        if (!serverReady) {
            await this.stopServer(deepnoteFileUri);
            throw new Error('Deepnote server failed to start within timeout period');
        }

        logger.info(`Deepnote server started successfully at ${url} for ${fileKey}`);
        this.outputChannel.appendLine(`✓ Deepnote server running at ${url}`);

        return serverInfo;
    }

    public async stopServer(deepnoteFileUri: Uri): Promise<void> {
        const fileKey = deepnoteFileUri.fsPath;

        // Wait for any pending operations on this file to complete
        const pendingOp = this.pendingOperations.get(fileKey);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on ${fileKey} before stopping...`);
            try {
                await pendingOp;
            } catch {
                // Ignore errors from previous operations
            }
        }

        // Start the stop operation and track it
        const operation = this.stopServerImpl(deepnoteFileUri);
        this.pendingOperations.set(fileKey, operation);

        try {
            await operation;
        } finally {
            // Remove from pending operations when done
            if (this.pendingOperations.get(fileKey) === operation) {
                this.pendingOperations.delete(fileKey);
            }
        }
    }

    private async stopServerImpl(deepnoteFileUri: Uri): Promise<void> {
        const fileKey = deepnoteFileUri.fsPath;
        const serverProcess = this.serverProcesses.get(fileKey);

        if (serverProcess) {
            try {
                logger.info(`Stopping Deepnote server for ${fileKey}...`);
                serverProcess.proc?.kill();
                this.serverProcesses.delete(fileKey);
                this.serverInfos.delete(fileKey);
                this.outputChannel.appendLine(`Deepnote server stopped for ${fileKey}`);
            } catch (ex) {
                logger.error(`Error stopping Deepnote server: ${ex}`);
            }
        }

        const disposables = this.disposablesByFile.get(fileKey);
        if (disposables) {
            disposables.forEach((d) => d.dispose());
            this.disposablesByFile.delete(fileKey);
        }
    }

    private async waitForServer(
        serverInfo: DeepnoteServerInfo,
        timeout: number,
        token?: CancellationToken
    ): Promise<boolean> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            Cancellation.throwIfCanceled(token);
            if (await this.isServerRunning(serverInfo)) {
                return true;
            }
            await raceCancellationError(token, sleep(500));
        }
        return false;
    }

    private async isServerRunning(serverInfo: DeepnoteServerInfo): Promise<boolean> {
        try {
            // Try to connect to the Jupyter API endpoint
            const exists = await this.httpClient.exists(`${serverInfo.url}/api`).catch(() => false);
            return exists;
        } catch {
            return false;
        }
    }

    public dispose(): void {
        logger.info('Disposing DeepnoteServerStarter - stopping all servers...');

        // Stop all server processes
        for (const [fileKey, serverProcess] of this.serverProcesses.entries()) {
            try {
                logger.info(`Stopping Deepnote server for ${fileKey}...`);
                serverProcess.proc?.kill();
            } catch (ex) {
                logger.error(`Error stopping Deepnote server for ${fileKey}: ${ex}`);
            }
        }

        // Dispose all tracked disposables
        for (const [fileKey, disposables] of this.disposablesByFile.entries()) {
            try {
                disposables.forEach((d) => d.dispose());
            } catch (ex) {
                logger.error(`Error disposing resources for ${fileKey}: ${ex}`);
            }
        }

        // Clear all maps
        this.serverProcesses.clear();
        this.serverInfos.clear();
        this.disposablesByFile.clear();
        this.pendingOperations.clear();

        logger.info('DeepnoteServerStarter disposed successfully');
    }
}
