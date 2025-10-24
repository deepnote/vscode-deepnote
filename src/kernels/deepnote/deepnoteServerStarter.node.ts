// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named, optional } from 'inversify';
import { CancellationToken, Uri } from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IDeepnoteServerStarter, IDeepnoteToolkitInstaller, DeepnoteServerInfo, DEEPNOTE_DEFAULT_PORT } from './types';
import { IProcessServiceFactory, ObservableExecutionResult } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { IOutputChannel, IDisposable, IHttpClient, IAsyncDisposableRegistry } from '../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { sleep } from '../../platform/common/utils/async';
import { Cancellation, raceCancellationError } from '../../platform/common/cancellation';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';
import getPort from 'get-port';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from '../../platform/vscode-path/path';
import { generateUuid } from '../../platform/common/uuid';
import { DeepnoteServerStartupError, DeepnoteServerTimeoutError } from '../../platform/errors/deepnoteKernelErrors';

/**
 * Lock file data structure for tracking server ownership
 */
interface ServerLockFile {
    sessionId: string;
    pid: number;
    timestamp: number;
}

/**
 * Starts and manages the deepnote-toolkit Jupyter server.
 */
@injectable()
export class DeepnoteServerStarter implements IDeepnoteServerStarter, IExtensionSyncActivationService {
    private readonly serverProcesses: Map<string, ObservableExecutionResult<string>> = new Map();
    private readonly serverInfos: Map<string, DeepnoteServerInfo> = new Map();
    private readonly disposablesByFile: Map<string, IDisposable[]> = new Map();
    // Track in-flight operations per file to prevent concurrent start/stop
    private readonly pendingOperations: Map<string, Promise<DeepnoteServerInfo | void>> = new Map();
    // Global lock for port allocation to prevent race conditions when multiple environments start concurrently
    private portAllocationLock: Promise<void> = Promise.resolve();
    // Unique session ID for this VS Code window instance
    private readonly sessionId: string = generateUuid();
    // Directory for lock files
    private readonly lockFileDir: string = path.join(os.tmpdir(), 'vscode-deepnote-locks');
    // Track server output for error reporting
    private readonly serverOutputByFile: Map<string, { stdout: string; stderr: string }> = new Map();

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IHttpClient) private readonly httpClient: IHttpClient,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry,
        @inject(ISqlIntegrationEnvVarsProvider)
        @optional()
        private readonly sqlIntegrationEnvVars?: ISqlIntegrationEnvVarsProvider
    ) {
        // Register for disposal when the extension deactivates
        asyncRegistry.push(this);
    }

    public activate(): void {
        // Ensure lock file directory exists
        this.initializeLockFileDirectory().catch((ex) => {
            logger.warn(`Failed to initialize lock file directory: ${ex}`);
        });

        // Clean up any orphaned deepnote-toolkit processes from previous sessions
        this.cleanupOrphanedProcesses().catch((ex) => {
            logger.warn(`Failed to cleanup orphaned processes: ${ex}`);
        });
    }

    /**
     * Environment-based method: Start a server for a kernel environment.
     * @param interpreter The Python interpreter to use
     * @param venvPath The path to the venv
     * @param environmentId The environment ID (used as key for server management)
     * @param token Cancellation token
     * @returns Server connection information
     */
    public async startServer(
        interpreter: PythonEnvironment,
        venvPath: Uri,
        environmentId: string,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        // Wait for any pending operations on this environment to complete
        const pendingOp = this.pendingOperations.get(environmentId);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on environment ${environmentId} to complete...`);
            try {
                await pendingOp;
            } catch {
                // Ignore errors from previous operations
            }
        }

        // If server is already running for this environment, return existing info
        const existingServerInfo = this.serverInfos.get(environmentId);
        if (existingServerInfo && (await this.isServerRunning(existingServerInfo))) {
            logger.info(
                `Deepnote server already running at ${existingServerInfo.url} for environment ${environmentId}`
            );
            return existingServerInfo;
        }

        // Start the operation and track it
        const operation = this.startServerForEnvironment(interpreter, venvPath, environmentId, token);
        this.pendingOperations.set(environmentId, operation);

        try {
            const result = await operation;
            return result;
        } finally {
            // Remove from pending operations when done
            if (this.pendingOperations.get(environmentId) === operation) {
                this.pendingOperations.delete(environmentId);
            }
        }
    }

    /**
     * Environment-based method: Stop the server for a kernel environment.
     * @param environmentId The environment ID
     */
    public async stopServer(environmentId: string): Promise<void> {
        // Wait for any pending operations on this environment to complete
        const pendingOp = this.pendingOperations.get(environmentId);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on environment ${environmentId} before stopping...`);
            try {
                await pendingOp;
            } catch {
                // Ignore errors from previous operations
            }
        }

        // Start the stop operation and track it
        const operation = this.stopServerForEnvironment(environmentId);
        this.pendingOperations.set(environmentId, operation);

        try {
            await operation;
        } finally {
            // Remove from pending operations when done
            if (this.pendingOperations.get(environmentId) === operation) {
                this.pendingOperations.delete(environmentId);
            }
        }
    }

    /**
     * Environment-based server start implementation.
     */
    private async startServerForEnvironment(
        interpreter: PythonEnvironment,
        venvPath: Uri,
        environmentId: string,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        Cancellation.throwIfCanceled(token);

        // Ensure toolkit is installed in venv and get venv's Python interpreter
        logger.info(`Ensuring deepnote-toolkit is installed in venv for environment ${environmentId}...`);
        const venvInterpreter = await this.toolkitInstaller.ensureVenvAndToolkit(interpreter, venvPath, token);
        if (!venvInterpreter) {
            throw new Error('Failed to install deepnote-toolkit. Please check the output for details.');
        }

        Cancellation.throwIfCanceled(token);

        // Allocate both ports with global lock to prevent race conditions
        // Note: allocatePorts reserves both ports immediately in serverInfos
        const { jupyterPort, lspPort } = await this.allocatePorts(environmentId);

        logger.info(
            `Starting deepnote-toolkit server on jupyter port ${jupyterPort} and lsp port ${lspPort} for environment ${environmentId}`
        );
        this.outputChannel.appendLine(
            `Starting Deepnote server on jupyter port ${jupyterPort} and lsp port ${lspPort}...`
        );

        // Start the server with venv's Python in PATH
        const processService = await this.processServiceFactory.create(undefined);

        // Set up environment to ensure the venv's Python is used for shell commands
        const venvBinDir = path.dirname(venvInterpreter.uri.fsPath);
        const env = { ...process.env };

        // Prepend venv bin directory to PATH so shell commands use venv's Python
        env.PATH = `${venvBinDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH || ''}`;

        // Also set VIRTUAL_ENV to indicate we're in a venv
        env.VIRTUAL_ENV = venvPath.fsPath;

        // Enforce published pip constraints to prevent breaking Deepnote Toolkit's dependencies
        env.DEEPNOTE_ENFORCE_PIP_CONSTRAINTS = 'true';

        // Detached mode
        env.DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE = 'true';

        // Detached mode ensures no requests are made to the backend (directly, or via proxy)
        // as there is no backend running in the extension, therefore:
        // 1. integration environment variables are injected here instead
        // 2. post start hooks won't work / are not executed
        env.DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE = 'true';

        // Inject SQL integration environment variables
        if (this.sqlIntegrationEnvVars) {
            logger.debug(`DeepnoteServerStarter: Injecting SQL integration env vars for environment ${environmentId}`);
            try {
                // const sqlEnvVars = await this.sqlIntegrationEnvVars.getEnvironmentVariables(deepnoteFileUri, token);
                const sqlEnvVars = {}; // TODO: update how environment variables are retrieved
                if (sqlEnvVars && Object.keys(sqlEnvVars).length > 0) {
                    logger.debug(`DeepnoteServerStarter: Injecting ${Object.keys(sqlEnvVars).length} SQL env vars`);
                    Object.assign(env, sqlEnvVars);
                } else {
                    logger.debug('DeepnoteServerStarter: No SQL integration env vars to inject');
                }
            } catch (error) {
                logger.error('DeepnoteServerStarter: Failed to get SQL integration env vars', error.message);
            }
        } else {
            logger.debug('DeepnoteServerStarter: SqlIntegrationEnvironmentVariablesProvider not available');
        }

        // Remove PYTHONHOME if it exists (can interfere with venv)
        delete env.PYTHONHOME;

        const serverProcess = processService.execObservable(
            venvInterpreter.uri.fsPath,
            [
                '-m',
                'deepnote_toolkit',
                'server',
                '--jupyter-port',
                jupyterPort.toString(),
                '--ls-port',
                lspPort.toString()
            ],
            { env }
        );

        this.serverProcesses.set(environmentId, serverProcess);

        // Track disposables for this environment
        const disposables: IDisposable[] = [];
        this.disposablesByFile.set(environmentId, disposables);

        // Initialize output tracking for error reporting
        this.serverOutputByFile.set(environmentId, { stdout: '', stderr: '' });

        // Monitor server output
        serverProcess.out.onDidChange(
            (output) => {
                const outputTracking = this.serverOutputByFile.get(environmentId);
                if (output.source === 'stdout') {
                    logger.trace(`Deepnote server (${environmentId}): ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                    if (outputTracking) {
                        // Keep last 5000 characters of output for error reporting
                        outputTracking.stdout = (outputTracking.stdout + output.out).slice(-5000);
                    }
                } else if (output.source === 'stderr') {
                    logger.warn(`Deepnote server stderr (${environmentId}): ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                    if (outputTracking) {
                        // Keep last 5000 characters of error output for error reporting
                        outputTracking.stderr = (outputTracking.stderr + output.out).slice(-5000);
                    }
                }
            },
            this,
            disposables
        );

        // Wait for server to be ready
        const url = `http://localhost:${jupyterPort}`;
        const serverInfo = { url, jupyterPort, lspPort };
        this.serverInfos.set(environmentId, serverInfo);

        // Write lock file for the server process
        const serverPid = serverProcess.proc?.pid;
        if (serverPid) {
            await this.writeLockFile(serverPid);
        } else {
            logger.warn(`Could not get PID for server process for environment ${environmentId}`);
        }

        try {
            const serverReady = await this.waitForServer(serverInfo, 120000, token);
            if (!serverReady) {
                const output = this.serverOutputByFile.get(environmentId);

                throw new DeepnoteServerTimeoutError(serverInfo.url, 120000, output?.stderr || undefined);
            }
        } catch (error) {
            if (error instanceof DeepnoteServerTimeoutError || error instanceof DeepnoteServerStartupError) {
                // await this.stopServerImpl(deepnoteFileUri);
                await this.stopServerForEnvironment(environmentId);
                throw error;
            }

            // Capture output BEFORE cleaning up (stopServerImpl deletes it)
            // const output = this.serverOutputByFile.get(fileKey);
            const output = this.serverOutputByFile.get(environmentId);
            const capturedStdout = output?.stdout || '';
            const capturedStderr = output?.stderr || '';

            // Clean up leaked server before rethrowing
            await this.stopServerForEnvironment(environmentId);
            // throw error;

            // TODO
            // Wrap in a generic server startup error with captured output
            throw new DeepnoteServerStartupError(
                interpreter.uri.fsPath,
                serverInfo.jupyterPort,
                'unknown',
                capturedStdout,
                capturedStderr,
                error instanceof Error ? error : undefined
            );
        }

        logger.info(`Deepnote server started successfully at ${url} for environment ${environmentId}`);
        this.outputChannel.appendLine(`✓ Deepnote server running at ${url}`);

        return serverInfo;
    }

    /**
     * Environment-based server stop implementation.
     */
    private async stopServerForEnvironment(environmentId: string): Promise<void> {
        const serverProcess = this.serverProcesses.get(environmentId);

        if (serverProcess) {
            const serverPid = serverProcess.proc?.pid;

            try {
                logger.info(`Stopping Deepnote server for environment ${environmentId}...`);
                serverProcess.proc?.kill();
                this.serverProcesses.delete(environmentId);
                this.serverInfos.delete(environmentId);
                this.serverOutputByFile.delete(environmentId);
                this.outputChannel.appendLine(`Deepnote server stopped for environment ${environmentId}`);

                // Clean up lock file after stopping the server
                if (serverPid) {
                    await this.deleteLockFile(serverPid);
                }
            } catch (ex) {
                logger.error(`Error stopping Deepnote server: ${ex}`);
            }
        }

        const disposables = this.disposablesByFile.get(environmentId);
        if (disposables) {
            disposables.forEach((d) => d.dispose());
            this.disposablesByFile.delete(environmentId);
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

    /**
     * Allocate both Jupyter and LSP ports atomically with global serialization.
     * When multiple environments start simultaneously, this ensures each gets unique ports.
     *
     * @param key The environment ID to reserve ports for
     * @returns Object with jupyterPort and lspPort
     */
    private async allocatePorts(key: string): Promise<{ jupyterPort: number; lspPort: number }> {
        // Wait for any ongoing port allocation to complete
        await this.portAllocationLock;

        // Create new allocation promise and update the lock
        let releaseLock: () => void;
        this.portAllocationLock = new Promise((resolve) => {
            releaseLock = resolve;
        });

        try {
            // Get all ports currently in use by our managed servers
            const portsInUse = new Set<number>();
            for (const serverInfo of this.serverInfos.values()) {
                if (serverInfo.jupyterPort) {
                    portsInUse.add(serverInfo.jupyterPort);
                }
                if (serverInfo.lspPort) {
                    portsInUse.add(serverInfo.lspPort);
                }
            }

            // Allocate Jupyter port first
            const jupyterPort = await this.findAvailablePort(DEEPNOTE_DEFAULT_PORT, portsInUse);
            portsInUse.add(jupyterPort); // Reserve it immediately

            // Allocate LSP port (starting from jupyterPort + 1 to avoid conflicts)
            const lspPort = await this.findAvailablePort(jupyterPort + 1, portsInUse);
            portsInUse.add(lspPort); // Reserve it immediately

            // Reserve both ports by adding to serverInfos
            // This prevents other concurrent allocations from getting the same ports
            const serverInfo = {
                url: `http://localhost:${jupyterPort}`,
                jupyterPort,
                lspPort
            };
            this.serverInfos.set(key, serverInfo);

            logger.info(
                `Allocated ports for ${key}: jupyter=${jupyterPort}, lsp=${lspPort} (excluded: ${
                    portsInUse.size > 2
                        ? Array.from(portsInUse)
                              .filter((p) => p !== jupyterPort && p !== lspPort)
                              .join(', ')
                        : 'none'
                })`
            );

            return { jupyterPort, lspPort };
        } finally {
            // Release the lock to allow next allocation
            releaseLock!();
        }
    }

    /**
     * Find an available port starting from the given port number.
     * Checks both our internal portsInUse set and system availability.
     */
    private async findAvailablePort(startPort: number, portsInUse: Set<number>): Promise<number> {
        let port = startPort;
        let attempts = 0;
        const maxAttempts = 100;

        while (attempts < maxAttempts) {
            // Skip ports already in use by our servers
            if (!portsInUse.has(port)) {
                // Check if this port is available on the system
                const availablePort = await getPort({
                    host: 'localhost',
                    port
                });

                // If get-port returned the same port, it's available
                if (availablePort === port) {
                    return port;
                }

                // get-port returned a different port - check if that one is in use
                if (!portsInUse.has(availablePort)) {
                    return availablePort;
                }

                // Both our requested port and get-port's suggestion are in use, try next
            }

            // Try next port
            port++;
            attempts++;
        }

        throw new Error(
            `Failed to find available port after ${maxAttempts} attempts (started at ${startPort}). Ports in use: ${Array.from(
                portsInUse
            ).join(', ')}`
        );
    }

    public async dispose(): Promise<void> {
        logger.info('Disposing DeepnoteServerStarter - stopping all servers...');

        // Wait for any pending operations to complete (with timeout)
        const pendingOps = Array.from(this.pendingOperations.values());
        if (pendingOps.length > 0) {
            logger.info(`Waiting for ${pendingOps.length} pending operations to complete...`);
            await Promise.allSettled(pendingOps.map((op) => Promise.race([op, sleep(2000)])));
        }

        // Stop all server processes and wait for them to exit
        const killPromises: Promise<void>[] = [];
        const pidsToCleanup: number[] = [];

        for (const [fileKey, serverProcess] of this.serverProcesses.entries()) {
            try {
                logger.info(`Stopping Deepnote server for ${fileKey}...`);
                const proc = serverProcess.proc;
                if (proc && !proc.killed) {
                    const serverPid = proc.pid;
                    if (serverPid) {
                        pidsToCleanup.push(serverPid);
                    }

                    // Create a promise that resolves when the process exits
                    const exitPromise = new Promise<void>((resolve) => {
                        const timeout = setTimeout(() => {
                            logger.warn(`Process for ${fileKey} did not exit gracefully, force killing...`);
                            try {
                                proc.kill('SIGKILL');
                            } catch {
                                // Ignore errors on force kill
                            }
                            resolve();
                        }, 3000); // Wait up to 3 seconds for graceful exit

                        proc.once('exit', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    });

                    // Send SIGTERM for graceful shutdown
                    proc.kill('SIGTERM');
                    killPromises.push(exitPromise);
                }
            } catch (ex) {
                logger.error(`Error stopping Deepnote server for ${fileKey}: ${ex}`);
            }
        }

        // Wait for all processes to exit
        if (killPromises.length > 0) {
            logger.info(`Waiting for ${killPromises.length} server processes to exit...`);
            await Promise.allSettled(killPromises);
        }

        // Clean up lock files for all stopped processes
        for (const pid of pidsToCleanup) {
            await this.deleteLockFile(pid);
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
        this.serverOutputByFile.clear();

        logger.info('DeepnoteServerStarter disposed successfully');
    }

    /**
     * Initialize the lock file directory
     */
    private async initializeLockFileDirectory(): Promise<void> {
        try {
            await fs.ensureDir(this.lockFileDir);
            logger.info(`Lock file directory initialized at ${this.lockFileDir} with session ID ${this.sessionId}`);
        } catch (ex) {
            logger.error(`Failed to create lock file directory: ${ex}`);
        }
    }

    /**
     * Get the lock file path for a given PID
     */
    private getLockFilePath(pid: number): string {
        return path.join(this.lockFileDir, `server-${pid}.json`);
    }

    /**
     * Write a lock file for a server process
     */
    private async writeLockFile(pid: number): Promise<void> {
        try {
            const lockData: ServerLockFile = {
                sessionId: this.sessionId,
                pid,
                timestamp: Date.now()
            };
            const lockFilePath = this.getLockFilePath(pid);
            await fs.writeJson(lockFilePath, lockData, { spaces: 2 });
            logger.info(`Created lock file for PID ${pid} with session ID ${this.sessionId}`);
        } catch (ex) {
            logger.warn(`Failed to write lock file for PID ${pid}: ${ex}`);
        }
    }

    /**
     * Read a lock file for a given PID
     */
    private async readLockFile(pid: number): Promise<ServerLockFile | null> {
        try {
            const lockFilePath = this.getLockFilePath(pid);
            if (await fs.pathExists(lockFilePath)) {
                return await fs.readJson(lockFilePath);
            }
        } catch (ex) {
            logger.warn(`Failed to read lock file for PID ${pid}: ${ex}`);
        }
        return null;
    }

    /**
     * Delete a lock file for a given PID
     */
    private async deleteLockFile(pid: number): Promise<void> {
        try {
            const lockFilePath = this.getLockFilePath(pid);
            if (await fs.pathExists(lockFilePath)) {
                await fs.remove(lockFilePath);
                logger.info(`Deleted lock file for PID ${pid}`);
            }
        } catch (ex) {
            logger.warn(`Failed to delete lock file for PID ${pid}: ${ex}`);
        }
    }

    /**
     * Check if a process is orphaned by verifying its parent process
     */
    private async isProcessOrphaned(pid: number): Promise<boolean> {
        try {
            const processService = await this.processServiceFactory.create(undefined);

            if (process.platform === 'win32') {
                // Windows: use WMIC to get parent process ID
                const result = await processService.exec(
                    'wmic',
                    ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId'],
                    { throwOnStdErr: false }
                );

                if (result.stdout) {
                    const lines = result.stdout
                        .split('\n')
                        .filter((line) => line.trim() && !line.includes('ParentProcessId'));
                    if (lines.length > 0) {
                        const ppid = parseInt(lines[0].trim(), 10);
                        if (!isNaN(ppid)) {
                            // PPID of 0 means orphaned
                            if (ppid === 0) {
                                return true;
                            }

                            // Check if parent process exists
                            const parentCheck = await processService.exec(
                                'tasklist',
                                ['/FI', `PID eq ${ppid}`, '/FO', 'CSV', '/NH'],
                                { throwOnStdErr: false }
                            );

                            // Normalize and check stdout
                            const stdout = (parentCheck.stdout || '').trim();

                            // Parent is missing if:
                            // 1. stdout is empty
                            // 2. stdout starts with "INFO:" (case-insensitive)
                            // 3. stdout contains "no tasks are running" (case-insensitive)
                            if (stdout.length === 0 || /^INFO:/i.test(stdout) || /no tasks are running/i.test(stdout)) {
                                return true; // Parent missing, process is orphaned
                            }

                            // Parent exists
                            return false;
                        }
                    }
                }
            } else {
                // Unix: use ps to get parent process ID
                const result = await processService.exec('ps', ['-o', 'ppid=', '-p', pid.toString()], {
                    throwOnStdErr: false
                });

                if (result.stdout) {
                    const ppid = parseInt(result.stdout.trim(), 10);
                    if (!isNaN(ppid)) {
                        // PPID of 1 typically means orphaned (adopted by init/systemd)
                        if (ppid === 1) {
                            return true;
                        }
                        // Check if parent process exists
                        const parentCheck = await processService.exec('ps', ['-p', ppid.toString(), '-o', 'pid='], {
                            throwOnStdErr: false
                        });
                        return parentCheck.stdout.trim().length === 0;
                    }
                }
            }
        } catch (ex) {
            logger.warn(`Failed to check if process ${pid} is orphaned: ${ex}`);
        }

        // If we can't determine, assume it's not orphaned (safer)
        return false;
    }

    /**
     * Cleans up any orphaned deepnote-toolkit processes from previous VS Code sessions.
     * This prevents port conflicts when starting new servers.
     */
    private async cleanupOrphanedProcesses(): Promise<void> {
        try {
            logger.info('Checking for orphaned deepnote-toolkit processes...');
            const processService = await this.processServiceFactory.create(undefined);

            // Find all deepnote-toolkit server processes
            let command: string;
            let args: string[];

            if (process.platform === 'win32') {
                // Windows: use tasklist and findstr
                command = 'tasklist';
                args = ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'];
            } else {
                // Unix-like: use ps and grep
                command = 'ps';
                args = ['aux'];
            }

            const result = await processService.exec(command, args, { throwOnStdErr: false });

            if (result.stdout) {
                const lines = result.stdout.split('\n');
                const candidatePids: number[] = [];

                for (const line of lines) {
                    // Look for processes running deepnote_toolkit server
                    if (line.includes('deepnote_toolkit') && line.includes('server')) {
                        // Extract PID based on platform
                        let pid: number | undefined;

                        if (process.platform === 'win32') {
                            // Windows CSV format: "python.exe","12345",...
                            const match = line.match(/"python\.exe","(\d+)"/);
                            if (match) {
                                pid = parseInt(match[1], 10);
                            }
                        } else {
                            // Unix format: user PID ...
                            const parts = line.trim().split(/\s+/);
                            if (parts.length > 1) {
                                pid = parseInt(parts[1], 10);
                            }
                        }

                        if (pid && !isNaN(pid)) {
                            candidatePids.push(pid);
                        }
                    }
                }

                if (candidatePids.length > 0) {
                    logger.info(
                        `Found ${candidatePids.length} deepnote-toolkit server process(es): ${candidatePids.join(', ')}`
                    );

                    const pidsToKill: number[] = [];
                    const pidsToSkip: Array<{ pid: number; reason: string }> = [];

                    // Check each process to determine if it should be killed
                    for (const pid of candidatePids) {
                        // Check if there's a lock file for this PID
                        const lockData = await this.readLockFile(pid);

                        if (lockData) {
                            // Lock file exists - check if it belongs to a different session
                            if (lockData.sessionId !== this.sessionId) {
                                // Different session - check if the process is actually orphaned
                                const isOrphaned = await this.isProcessOrphaned(pid);
                                if (isOrphaned) {
                                    logger.info(
                                        `PID ${pid} belongs to session ${lockData.sessionId} and is orphaned - will kill`
                                    );
                                    pidsToKill.push(pid);
                                } else {
                                    pidsToSkip.push({
                                        pid,
                                        reason: `belongs to active session ${lockData.sessionId.substring(0, 8)}...`
                                    });
                                }
                            } else {
                                // Same session - this shouldn't happen during startup, but skip it
                                pidsToSkip.push({ pid, reason: 'belongs to current session' });
                            }
                        } else {
                            // No lock file - check if orphaned before killing
                            const isOrphaned = await this.isProcessOrphaned(pid);
                            if (isOrphaned) {
                                logger.info(`PID ${pid} has no lock file and is orphaned - will kill`);
                                pidsToKill.push(pid);
                            } else {
                                pidsToSkip.push({ pid, reason: 'no lock file but has active parent process' });
                            }
                        }
                    }

                    // Log skipped processes
                    if (pidsToSkip.length > 0) {
                        for (const { pid, reason } of pidsToSkip) {
                            logger.info(`Skipping PID ${pid}: ${reason}`);
                        }
                    }

                    // Kill orphaned processes
                    if (pidsToKill.length > 0) {
                        logger.info(`Killing ${pidsToKill.length} orphaned process(es): ${pidsToKill.join(', ')}`);
                        this.outputChannel.appendLine(
                            `Cleaning up ${pidsToKill.length} orphaned deepnote-toolkit process(es)...`
                        );

                        for (const pid of pidsToKill) {
                            try {
                                if (process.platform === 'win32') {
                                    await processService.exec('taskkill', ['/F', '/T', '/PID', pid.toString()], {
                                        throwOnStdErr: false
                                    });
                                } else {
                                    await processService.exec('kill', ['-9', pid.toString()], { throwOnStdErr: false });
                                }
                                logger.info(`Killed orphaned process ${pid}`);

                                // Clean up the lock file after killing
                                await this.deleteLockFile(pid);
                            } catch (ex) {
                                logger.warn(`Failed to kill process ${pid}: ${ex}`);
                            }
                        }

                        this.outputChannel.appendLine('✓ Cleanup complete');
                    } else {
                        logger.info('No orphaned deepnote-toolkit processes found (all processes are active)');
                    }
                } else {
                    logger.info('No deepnote-toolkit server processes found');
                }
            }
        } catch (ex) {
            // Don't fail startup if cleanup fails
            logger.warn(`Error during orphaned process cleanup: ${ex}`);
        }
    }
}
