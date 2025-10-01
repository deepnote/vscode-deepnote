// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IDeepnoteServerStarter, IDeepnoteToolkitInstaller, DeepnoteServerInfo, DEEPNOTE_DEFAULT_PORT } from './types';
import { IProcessServiceFactory, ObservableExecutionResult } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { IOutputChannel, IDisposable } from '../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { sleep } from '../../platform/common/utils/async';
import { HttpClient } from '../../platform/common/net/httpClient';
import getPort from 'get-port';

/**
 * Starts and manages the deepnote-toolkit Jupyter server.
 */
@injectable()
export class DeepnoteServerStarter implements IDeepnoteServerStarter {
    private serverProcess?: ObservableExecutionResult<string>;
    private serverInfo?: DeepnoteServerInfo;
    private readonly disposables: IDisposable[] = [];
    private readonly httpClient = new HttpClient();

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel
    ) {}

    public async getOrStartServer(interpreter: PythonEnvironment): Promise<DeepnoteServerInfo> {
        // If server is already running, return existing info
        if (this.serverInfo && (await this.isServerRunning(this.serverInfo))) {
            logger.info(`Deepnote server already running at ${this.serverInfo.url}`);
            return this.serverInfo;
        }

        // Ensure toolkit is installed
        logger.info('Ensuring deepnote-toolkit is installed...');
        const installed = await this.toolkitInstaller.ensureInstalled(interpreter);
        if (!installed) {
            throw new Error('Failed to install deepnote-toolkit. Please check the output for details.');
        }

        // Find available port
        const port = await getPort({ host: 'localhost', port: DEEPNOTE_DEFAULT_PORT });
        logger.info(`Starting deepnote-toolkit server on port ${port}`);
        this.outputChannel.appendLine(`Starting Deepnote server on port ${port}...`);

        // Start the server
        const processService = await this.processServiceFactory.create(interpreter.uri);

        this.serverProcess = processService.execObservable(interpreter.uri.fsPath, [
            '-m',
            'deepnote_toolkit',
            'server',
            '--jupyter-port',
            port.toString()
        ]);

        // Monitor server output
        this.serverProcess.out.onDidChange(
            (output) => {
                if (output.source === 'stdout') {
                    logger.trace(`Deepnote server: ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                } else if (output.source === 'stderr') {
                    logger.warn(`Deepnote server stderr: ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                }
            },
            this,
            this.disposables
        );

        // Wait for server to be ready
        const url = `http://localhost:${port}`;
        this.serverInfo = { url, port };

        const serverReady = await this.waitForServer(this.serverInfo, 30000);
        if (!serverReady) {
            await this.stopServer();
            throw new Error('Deepnote server failed to start within timeout period');
        }

        logger.info(`Deepnote server started successfully at ${url}`);
        this.outputChannel.appendLine(`✓ Deepnote server running at ${url}`);

        return this.serverInfo;
    }

    public async stopServer(): Promise<void> {
        if (this.serverProcess) {
            try {
                logger.info('Stopping Deepnote server...');
                this.serverProcess.proc?.kill();
                this.serverProcess = undefined;
                this.serverInfo = undefined;
                this.outputChannel.appendLine('Deepnote server stopped');
            } catch (ex) {
                logger.error(`Error stopping Deepnote server: ${ex}`);
            }
        }
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }

    private async waitForServer(serverInfo: DeepnoteServerInfo, timeout: number): Promise<boolean> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            if (await this.isServerRunning(serverInfo)) {
                return true;
            }
            await sleep(500);
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
}
