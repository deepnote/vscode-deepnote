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

        // Ensure toolkit is installed (will throw typed errors on failure)
        logger.info(`Ensuring deepnote-toolkit is installed for ${fileKey}...`);
        await this.toolkitInstaller.ensureInstalled(interpreter, deepnoteFileUri, token);

        Cancellation.throwIfCanceled(token);

        // Find available port
        const port = await getPort({ host: 'localhost', port: DEEPNOTE_DEFAULT_PORT });
        logger.info(`Starting deepnote-toolkit server on port ${port} for ${fileKey}`);
        this.outputChannel.appendLine(`Starting Deepnote server on port ${port} for ${deepnoteFileUri.fsPath}...`);

        // Start the server with venv's Python in PATH
        // This ensures shell commands (!) in notebooks use the venv's Python
        // Use undefined as resource to get full system environment (including git in PATH)
        const processService = await this.processServiceFactory.create(undefined);

        // Set up environment to ensure the venv's Python is used for shell commands
        const venvBinDir = interpreter.uri.fsPath.replace(/\/python$/, '').replace(/\\python\.exe$/, '');
        const env = { ...process.env };

        // Prepend venv bin directory to PATH so shell commands use venv's Python
        env.PATH = `${venvBinDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH || ''}`;

        // Also set VIRTUAL_ENV to indicate we're in a venv
        const venvPath = venvBinDir.replace(/\/bin$/, '').replace(/\\Scripts$/, '');
        env.VIRTUAL_ENV = venvPath;

        // Enforce published pip constraints to prevent breaking Deepnote Toolkit's dependencies
        env.DEEPNOTE_ENFORCE_PIP_CONSTRAINTS = 'true';

        // Detached mode ensures no requests are made to the backend (directly, or via proxy)
        // as there is no backend running in the extension, therefore:
        // 1. integration environment variables are injected here instead
        // 2. post start hooks won't work / are not executed
        env.DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE = 'true';

        // Inject SQL integration environment variables
        if (this.sqlIntegrationEnvVars) {
            logger.debug(`DeepnoteServerStarter: Injecting SQL integration env vars for ${deepnoteFileUri.toString()}`);
            try {
                const sqlEnvVars = await this.sqlIntegrationEnvVars.getEnvironmentVariables(deepnoteFileUri, token);
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

        // Get the directory containing the notebook file to set as working directory
        // This ensures relative file paths in the notebook work correctly
        const notebookDir = Uri.joinPath(deepnoteFileUri, '..').fsPath;

        const serverProcess = processService.execObservable(
            interpreter.uri.fsPath,
            ['-m', 'deepnote_toolkit', 'server', '--jupyter-port', port.toString()],
            {
                env,
                cwd: notebookDir
            }
        );

        this.serverProcesses.set(fileKey, serverProcess);

        // Track disposables for this file
        const disposables: IDisposable[] = [];
        this.disposablesByFile.set(fileKey, disposables);

        // Initialize output tracking for error reporting
        this.serverOutputByFile.set(fileKey, { stdout: '', stderr: '' });

        // Monitor server output
        serverProcess.out.onDidChange(
            (output) => {
                const outputTracking = this.serverOutputByFile.get(fileKey);
                if (output.source === 'stdout') {
                    logger.trace(`Deepnote server (${fileKey}): ${output.out}`);
                    this.outputChannel.appendLine(output.out);
                    if (outputTracking) {
                        // Keep last 5000 characters of output for error reporting
                        outputTracking.stdout = (outputTracking.stdout + output.out).slice(-5000);
                    }
                } else if (output.source === 'stderr') {
                    logger.warn(`Deepnote server stderr (${fileKey}): ${output.out}`);
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
        const url = `http://localhost:${port}`;
        const serverInfo = { url, port };
        this.serverInfos.set(fileKey, serverInfo);

        // Write lock file for the server process
        const serverPid = serverProcess.proc?.pid;
        if (serverPid) {
            await this.writeLockFile(serverPid);
        } else {
            logger.warn(`Could not get PID for server process for ${fileKey}`);
        }

        try {
            const serverReady = await this.waitForServer(serverInfo, 120000, token);
            if (!serverReady) {
                const output = this.serverOutputByFile.get(fileKey);
                await this.stopServerImpl(deepnoteFileUri);

                throw new DeepnoteServerTimeoutError(serverInfo.url, 120000, output?.stderr || undefined);
            }
        } catch (error) {
            // If this is already a DeepnoteKernelError, clean up and rethrow it
            if (error instanceof DeepnoteServerTimeoutError || error instanceof DeepnoteServerStartupError) {
                await this.stopServerImpl(deepnoteFileUri);
                throw error;
            }

            // Capture output BEFORE cleaning up (stopServerImpl deletes it)
            const output = this.serverOutputByFile.get(fileKey);
            const capturedStdout = output?.stdout || '';
            const capturedStderr = output?.stderr || '';

            // Clean up leaked server after capturing output
            await this.stopServerImpl(deepnoteFileUri);

            // Wrap in a generic server startup error with captured output
            throw new DeepnoteServerStartupError(
                interpreter.uri.fsPath,
                port,
                'unknown',
                capturedStdout,
                capturedStderr,
                error instanceof Error ? error : undefined
            );
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
            const serverPid = serverProcess.proc?.pid;

            try {
                logger.info(`Stopping Deepnote server for ${fileKey}...`);
                serverProcess.proc?.kill();
                this.serverProcesses.delete(fileKey);
                this.serverInfos.delete(fileKey);
                this.serverOutputByFile.delete(fileKey);
                this.outputChannel.appendLine(`Deepnote server stopped for ${fileKey}`);

                // Clean up lock file after stopping the server
                if (serverPid) {
                    await this.deleteLockFile(serverPid);
                }
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
     * Check if a process is a deepnote-toolkit related process by examining its command line.
     */
    private async isDeepnoteRelatedProcess(pid: number): Promise<boolean> {
        try {
            const processService = await this.processServiceFactory.create(undefined);

            if (process.platform === 'win32') {
                // Windows: prefer PowerShell CIM, fallback to WMIC
                let cmdLine = '';
                try {
                    const ps = await processService.exec(
                        'powershell.exe',
                        [
                            '-NoProfile',
                            '-Command',
                            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
                        ],
                        { throwOnStdErr: false }
                    );
                    cmdLine = (ps.stdout || '').toLowerCase();
                } catch {
                    // Ignore PowerShell errors, will fallback to WMIC
                }
                if (!cmdLine) {
                    const result = await processService.exec(
                        'wmic',
                        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
                        { throwOnStdErr: false }
                    );
                    cmdLine = (result.stdout || '').toLowerCase();
                }
                if (cmdLine) {
                    // Use regex to match path separators for more robust detection
                    const inVenv = /[\\/](deepnote-venvs)[\\/]/i.test(cmdLine);
                    return inVenv || cmdLine.includes('deepnote_toolkit');
                }
            } else {
                // Unix-like: use ps with -ww to avoid truncation of long command lines
                const result = await processService.exec('ps', ['-ww', '-p', pid.toString(), '-o', 'command='], {
                    throwOnStdErr: false
                });
                if (result.stdout) {
                    const cmdLine = result.stdout.toLowerCase();
                    // Use regex to match path separators for more robust detection
                    const inVenv = /[\\/](deepnote-venvs)[\\/]/i.test(cmdLine);
                    return inVenv || cmdLine.includes('deepnote_toolkit');
                }
            }
        } catch (ex) {
            logger.debug(`Failed to check if process ${pid} is deepnote-related: ${ex}`);
        }
        return false;
    }

    /**
     * Check if a process is still alive.
     */
    private async isProcessAlive(pid: number): Promise<boolean> {
        try {
            const processService = await this.processServiceFactory.create(undefined);
            if (process.platform === 'win32') {
                // Use CSV format for reliable parsing
                const result = await processService.exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
                    throwOnStdErr: false
                });

                // Parse CSV output to find matching PID
                const lines = result.stdout.split('\n');
                for (const line of lines) {
                    // Skip INFO: messages and empty lines
                    if (line.trim().startsWith('INFO:') || line.trim() === '') {
                        continue;
                    }

                    try {
                        // CSV format: "ImageName","PID","SessionName","Session#","MemUsage"
                        // Example: "python.exe","12345","Console","1","50,000 K"
                        // PID is in the second column (index 1)
                        const match = line.match(/"[^"]*","(\d+)"/);
                        if (match) {
                            const linePid = parseInt(match[1], 10);
                            if (!isNaN(linePid) && linePid === pid) {
                                return true;
                            }
                        }
                    } catch {
                        // Ignore parse errors for individual lines
                        continue;
                    }
                }
                return false;
            } else {
                // Use kill -0 to check if process exists (doesn't actually kill)
                // If it succeeds, process exists; if it fails, process doesn't exist
                try {
                    await processService.exec('kill', ['-0', pid.toString()], { throwOnStdErr: false });
                    return true;
                } catch {
                    return false;
                }
            }
        } catch {
            return false;
        }
    }

    /**
     * Attempt graceful kill (SIGTERM) then escalate to SIGKILL if needed.
     */
    private async killProcessGracefully(
        pid: number,
        processService: import('../../platform/common/process/types.node').IProcessService
    ): Promise<void> {
        try {
            // Try graceful termination first (SIGTERM)
            logger.debug(`Attempting graceful termination of process ${pid} (SIGTERM)...`);
            await processService.exec('kill', [pid.toString()], { throwOnStdErr: false });

            // Wait a bit for graceful shutdown
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Check if still alive
            const stillAlive = await this.isProcessAlive(pid);
            if (stillAlive) {
                logger.debug(`Process ${pid} did not terminate gracefully, escalating to SIGKILL...`);
                await processService.exec('kill', ['-9', pid.toString()], { throwOnStdErr: false });
            } else {
                logger.debug(`Process ${pid} terminated gracefully`);
            }
        } catch (ex) {
            logger.debug(`Error during graceful kill of process ${pid}: ${ex}`);
        }
    }

    /**
     * Find and kill orphaned deepnote-toolkit processes using specific ports.
     * This is useful for cleaning up LSP servers and Jupyter servers that may be stuck.
     * Only kills processes that are both orphaned AND deepnote-related.
     */
    private async cleanupProcessesByPort(port: number): Promise<void> {
        try {
            const processService = await this.processServiceFactory.create(undefined);

            if (process.platform === 'win32') {
                // Windows: use netstat to find LISTENING processes on port
                const result = await processService.exec('netstat', ['-ano'], { throwOnStdErr: false });
                if (result.stdout) {
                    const lines = result.stdout.split('\n');
                    const uniquePids = new Set<number>();

                    // Parse and deduplicate PIDs
                    for (const line of lines) {
                        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
                            const parts = line.trim().split(/\s+/);
                            const pid = parseInt(parts[parts.length - 1], 10);
                            if (!isNaN(pid) && pid > 0) {
                                uniquePids.add(pid);
                            }
                        }
                    }

                    // Process each unique PID
                    for (const pid of uniquePids) {
                        // Check if it's deepnote-related first
                        const isDeepnoteRelated = await this.isDeepnoteRelatedProcess(pid);
                        if (!isDeepnoteRelated) {
                            logger.debug(`Process ${pid} on port ${port} is not deepnote-related, skipping`);
                            continue;
                        }

                        const isOrphaned = await this.isProcessOrphaned(pid);
                        if (isOrphaned) {
                            logger.info(
                                `Found orphaned deepnote-related process ${pid} using port ${port}, killing process tree...`
                            );
                            // Try without /F first (graceful)
                            try {
                                await processService.exec('taskkill', ['/T', '/PID', pid.toString()], {
                                    throwOnStdErr: false
                                });
                                logger.debug(`Gracefully killed process ${pid}`);
                            } catch (gracefulError) {
                                // If graceful kill failed, use /F (force)
                                logger.debug(`Graceful kill failed for ${pid}, using /F flag...`);
                                try {
                                    await processService.exec('taskkill', ['/F', '/T', '/PID', pid.toString()], {
                                        throwOnStdErr: false
                                    });
                                } catch (forceError) {
                                    logger.debug(`Force kill also failed for ${pid}: ${forceError}`);
                                }
                            }
                        } else {
                            logger.debug(`Deepnote-related process ${pid} on port ${port} has active parent, skipping`);
                        }
                    }
                }
            } else {
                // Unix-like: try lsof first, fallback to ss
                let uniquePids = new Set<number>();

                // Try lsof with LISTEN filter
                try {
                    const lsofResult = await processService.exec('lsof', ['-sTCP:LISTEN', '-i', `:${port}`, '-t'], {
                        throwOnStdErr: false
                    });
                    if (lsofResult.stdout) {
                        const pids = lsofResult.stdout
                            .trim()
                            .split('\n')
                            .map((p) => parseInt(p.trim(), 10))
                            .filter((p) => !isNaN(p) && p > 0);
                        pids.forEach((pid) => uniquePids.add(pid));
                    }
                } catch (lsofError) {
                    logger.debug(`lsof failed or unavailable, trying ss: ${lsofError}`);
                }

                // Fallback to ss if lsof didn't find anything or failed
                if (uniquePids.size === 0) {
                    try {
                        const ssResult = await processService.exec('ss', ['-tlnp', `sport = :${port}`], {
                            throwOnStdErr: false
                        });
                        if (ssResult.stdout) {
                            // Parse ss output: look for pid=<number>
                            const pidMatches = ssResult.stdout.matchAll(/pid=(\d+)/g);
                            for (const match of pidMatches) {
                                const pid = parseInt(match[1], 10);
                                if (!isNaN(pid) && pid > 0) {
                                    uniquePids.add(pid);
                                }
                            }
                        }
                    } catch (ssError) {
                        logger.debug(`ss also failed: ${ssError}`);
                    }
                }

                if (uniquePids.size === 0) {
                    logger.debug(`No processes found listening on port ${port}`);
                    return;
                }

                // Process each unique PID
                for (const pid of uniquePids) {
                    // Check if it's deepnote-related first
                    const isDeepnoteRelated = await this.isDeepnoteRelatedProcess(pid);
                    if (!isDeepnoteRelated) {
                        logger.debug(`Process ${pid} on port ${port} is not deepnote-related, skipping`);
                        continue;
                    }

                    const isOrphaned = await this.isProcessOrphaned(pid);
                    if (isOrphaned) {
                        logger.info(
                            `Found orphaned deepnote-related process ${pid} using port ${port}, attempting graceful kill...`
                        );
                        await this.killProcessGracefully(pid, processService);
                    } else {
                        logger.debug(`Deepnote-related process ${pid} on port ${port} has active parent, skipping`);
                    }
                }
            }
        } catch (ex) {
            logger.debug(`Failed to cleanup processes on port ${port}: ${ex}`);
        }
    }

    /**
     * Cleans up any orphaned deepnote-toolkit processes from previous VS Code sessions.
     * This prevents port conflicts when starting new servers.
     */
    private async cleanupOrphanedProcesses(): Promise<void> {
        try {
            const startTime = Date.now();
            logger.info('Checking for orphaned deepnote-toolkit processes...');

            // First, clean up any orphaned processes using known ports
            // This catches LSP servers (2087) and Jupyter servers (8888-8895) that may be stuck
            await this.cleanupProcessesByPort(2087); // Python LSP server

            // Scan common Jupyter port range (8888-8895)
            // Jupyter typically uses 8888 but will increment if that port is busy
            for (let port = 8888; port <= 8895; port++) {
                await this.cleanupProcessesByPort(port);
            }

            const portCleanupTime = Date.now() - startTime;
            logger.debug(`Port-based cleanup completed in ${portCleanupTime}ms`);

            const processService = await this.processServiceFactory.create(undefined);

            // Find all deepnote-toolkit server processes and related child processes
            const candidatePids: number[] = [];

            if (process.platform === 'win32') {
                // Windows: tasklist CSV doesn't include command lines, so we need a two-step approach:
                // 1. Get all python.exe and pythonw.exe PIDs
                // 2. Check each PID's command line to see if it's deepnote-related

                // Step 1: Get all Python process PIDs
                const pythonPids: number[] = [];

                // Check python.exe
                const pythonResult = await processService.exec(
                    'tasklist',
                    ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'],
                    { throwOnStdErr: false }
                );
                if (pythonResult.stdout) {
                    const lines = pythonResult.stdout.split('\n');
                    for (const line of lines) {
                        // Windows CSV format: "python.exe","12345",...
                        const match = line.match(/"python\.exe","(\d+)"/);
                        if (match) {
                            const pid = parseInt(match[1], 10);
                            if (!isNaN(pid)) {
                                pythonPids.push(pid);
                            }
                        }
                    }
                }

                // Check pythonw.exe
                const pythonwResult = await processService.exec(
                    'tasklist',
                    ['/FI', 'IMAGENAME eq pythonw.exe', '/FO', 'CSV', '/NH'],
                    { throwOnStdErr: false }
                );
                if (pythonwResult.stdout) {
                    const lines = pythonwResult.stdout.split('\n');
                    for (const line of lines) {
                        // Windows CSV format: "pythonw.exe","12345",...
                        const match = line.match(/"pythonw\.exe","(\d+)"/);
                        if (match) {
                            const pid = parseInt(match[1], 10);
                            if (!isNaN(pid)) {
                                pythonPids.push(pid);
                            }
                        }
                    }
                }

                logger.debug(`Found ${pythonPids.length} Python process(es) on Windows`);

                // Step 2: Check each Python PID to see if it's deepnote-related
                for (const pid of pythonPids) {
                    const isDeepnoteRelated = await this.isDeepnoteRelatedProcess(pid);
                    if (isDeepnoteRelated) {
                        candidatePids.push(pid);
                    }
                }
            } else {
                // Unix-like: use ps with full command line
                const result = await processService.exec('ps', ['aux'], { throwOnStdErr: false });

                if (result.stdout) {
                    const lines = result.stdout.split('\n');

                    for (const line of lines) {
                        // Look for processes running deepnote_toolkit server or related child processes
                        // This includes:
                        // - deepnote_toolkit server (main server process)
                        // - pylsp (Python LSP server child process)
                        // - jupyter (Jupyter server child process)
                        const isDeepnoteRelated =
                            (line.includes('deepnote_toolkit') && line.includes('server')) ||
                            (line.includes('pylsp') && line.includes('2087')) || // LSP server on port 2087
                            (line.includes('jupyter') && line.includes('deepnote'));

                        if (isDeepnoteRelated) {
                            // Unix format: user PID ...
                            const parts = line.trim().split(/\s+/);
                            if (parts.length > 1) {
                                const pid = parseInt(parts[1], 10);
                                if (!isNaN(pid)) {
                                    candidatePids.push(pid);
                                }
                            }
                        }
                    }
                }
            }

            if (candidatePids.length > 0) {
                logger.info(`Found ${candidatePids.length} deepnote-related process(es): ${candidatePids.join(', ')}`);

                const pidsToKill: number[] = [];
                const pidsToSkip: Array<{ pid: number; reason: string }> = [];

                // Check each process to determine if it should be killed
                for (const pid of candidatePids) {
                    // Check if there's a lock file for this PID (only main server processes have lock files)
                    const lockData = await this.readLockFile(pid);

                    if (lockData) {
                        // Lock file exists - this is a main server process
                        // Check if it belongs to a different session
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
                        // No lock file - could be a child process (LSP, Jupyter) or orphaned main process
                        // Check if orphaned before killing
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
                        `Cleaning up ${pidsToKill.length} orphaned deepnote-related process(es)...`
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

                            // Clean up the lock file after killing (if it exists)
                            await this.deleteLockFile(pid);
                        } catch (ex) {
                            logger.warn(`Failed to kill process ${pid}: ${ex}`);
                        }
                    }

                    this.outputChannel.appendLine('✓ Cleanup complete');
                } else {
                    logger.info('No orphaned deepnote-related processes found (all processes are active)');
                }
            } else {
                logger.info('No deepnote-related processes found');
            }
        } catch (ex) {
            // Don't fail startup if cleanup fails
            logger.warn(`Error during orphaned process cleanup: ${ex}`);
        }
    }
}
