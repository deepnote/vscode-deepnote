/**
 * @deepnote/runtime-core functions not currently exported that would be useful:
 * - waitForServer(info, timeoutMs) — health-check polling on /api
 * - createJsonWebSocketFactory() — forces JSON-only Jupyter WS protocol, potential stability improvement
 * - ExecutionEngine.toPythonLiteral(value) — JS-to-Python literal conversion
 */

import * as fs from 'fs-extra';
import { inject, injectable, named } from 'inversify';
import * as os from 'os';
import { CancellationToken, CancellationTokenSource, l10n, Uri } from 'vscode';

import { startServer, stopServer } from '@deepnote/runtime-core';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { Cancellation } from '../../platform/common/cancellation';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IDisposable, IOutputChannel } from '../../platform/common/types';
import { sleep } from '../../platform/common/utils/async';
import { generateUuid } from '../../platform/common/uuid';
import { DeepnoteServerStartupError } from '../../platform/errors/deepnoteKernelErrors';
import { getCachedEnvironment } from '../../platform/interpreter/helpers';
import { IInstaller, InstallerResponse, Product } from '../../platform/interpreter/installer/types';
import { logger } from '../../platform/logging';
import { IUserpodApiEndpoints } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import * as path from '../../platform/vscode-path/path';
import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { applyIntegrationEndpointEnv } from './deepnoteIntegrationEndpointEnv';
import { DeepnoteServerInfo, IDeepnoteServerStarter } from './types';

const MAX_OUTPUT_TRACKING_LENGTH = 5000;
const SERVER_STARTUP_TIMEOUT_MS = 120_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3000;

interface ServerLockFile {
    sessionId: string;
    pid: number;
    timestamp: number;
}

type PendingOperation =
    | {
          type: 'start';
          promise: Promise<DeepnoteServerInfo>;
      }
    | {
          type: 'stop';
          promise: Promise<void>;
      };

interface ProjectContext {
    interpreterId: string;
    serverInfo: DeepnoteServerInfo | null;
}

/**
 * Starts and manages the deepnote-toolkit Jupyter server.
 *
 * Uses @deepnote/runtime-core's `startServer`/`stopServer` for the core server
 * lifecycle (process spawn, port discovery, health checks, shutdown), and layers
 * extension-specific concerns on top: lock files, orphan cleanup, integration
 * endpoint env vars, output channel logging, and multi-server concurrency control.
 */
@injectable()
export class DeepnoteServerStarter implements IDeepnoteServerStarter, IExtensionSyncActivationService {
    private readonly disposablesByFile: Map<string, IDisposable[]> = new Map();
    private readonly pendingOperations: Map<string, PendingOperation> = new Map();
    private readonly projectContexts: Map<string, ProjectContext> = new Map();
    private readonly serverOutputByFile: Map<string, { stdout: string; stderr: string }> = new Map();
    private readonly sessionId: string = generateUuid();
    private readonly lockFileDir: string = path.join(os.tmpdir(), 'vscode-deepnote-locks');

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IInstaller) private readonly installer: IInstaller,
        @inject(DeepnoteAgentSkillsManager) private readonly agentSkillsManager: DeepnoteAgentSkillsManager,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry,
        @inject(IUserpodApiEndpoints)
        private readonly userpodApiEndpoints: IUserpodApiEndpoints
    ) {
        asyncRegistry.push(this);
    }

    public activate(): void {
        this.initializeLockFileDirectory().catch((ex) => {
            logger.warn('Failed to initialize lock file directory', ex);
        });

        this.cleanupOrphanedProcesses().catch((ex) => {
            logger.warn('Failed to cleanup orphaned processes', ex);
        });
    }

    /**
     * Start a server for a kernel environment.
     * Serializes concurrent operations on the same environment to prevent race conditions.
     */
    public async startServer(
        interpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        const fileKey = deepnoteFileUri.fsPath;
        const interpreterId = interpreter.id;

        let pendingOp = this.pendingOperations.get(fileKey);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on ${fileKey} to complete...`);
            try {
                await pendingOp.promise;
            } catch {
                // Ignore errors from previous operations
            }
        }

        let existingContext = this.projectContexts.get(fileKey);
        if (existingContext != null) {
            const { interpreterId: existingInterpreterId, serverInfo: existingServerInfo } = existingContext;

            if (existingInterpreterId === interpreterId) {
                if (existingServerInfo != null && (await this.isServerRunning(existingServerInfo))) {
                    logger.info(
                        `Deepnote server already running at ${existingServerInfo.url} for ${fileKey} (interpreter ${interpreterId})`
                    );
                    return existingServerInfo;
                }

                pendingOp = this.pendingOperations.get(fileKey);

                if (pendingOp && pendingOp.type === 'start') {
                    return await pendingOp.promise;
                }
            } else {
                logger.info(
                    `Stopping existing server for ${fileKey} with interpreter ${existingInterpreterId} to start new one with interpreter ${interpreterId}...`
                );
                await this.stopServerForEnvironment(existingContext, deepnoteFileUri, token);
                existingContext = { interpreterId, serverInfo: null };
                this.projectContexts.set(fileKey, existingContext);
            }
        } else {
            const newContext: ProjectContext = {
                interpreterId,
                serverInfo: null
            };

            this.projectContexts.set(fileKey, newContext);
            existingContext = newContext;
        }

        const operation = {
            type: 'start' as const,
            promise: this.startServerForEnvironment(existingContext, interpreter, deepnoteFileUri, token)
        };
        this.pendingOperations.set(fileKey, operation);

        try {
            const result = await operation.promise;

            existingContext.serverInfo = result;
            return result;
        } finally {
            if (this.pendingOperations.get(fileKey) === operation) {
                this.pendingOperations.delete(fileKey);
            }
        }
    }

    /**
     * Stop the deepnote-toolkit server for a kernel environment.
     */
    public async stopServer(deepnoteFileUri: Uri, token?: CancellationToken): Promise<void> {
        Cancellation.throwIfCanceled(token);

        const fileKey = deepnoteFileUri.fsPath;
        const projectContext = this.projectContexts.get(fileKey) ?? null;

        if (projectContext == null) {
            logger.warn(`No project context found for ${fileKey}, skipping stop server...`);
            return;
        }

        const pendingOp = this.pendingOperations.get(fileKey);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on ${fileKey} before stopping...`);
            try {
                await pendingOp.promise;
            } catch {
                // Ignore errors from previous operations
            }
        }

        Cancellation.throwIfCanceled(token);

        const operation = {
            type: 'stop' as const,
            promise: this.stopServerForEnvironment(projectContext, deepnoteFileUri, token)
        };
        this.pendingOperations.set(fileKey, operation);

        try {
            await operation.promise;
        } finally {
            if (this.pendingOperations.get(fileKey) === operation) {
                this.pendingOperations.delete(fileKey);
            }
        }
    }

    /**
     * Core server start using @deepnote/runtime-core's `startServer`.
     *
     * Extension-specific layers:
     * - Toolkit check/install via IInstaller (before start)
     * - Integration endpoint env var injection (via ServerOptions.env) — these point the toolkit at the
     *   extension's loopback `userpod-api` endpoint, which is how it fetches SQL credentials at kernel init
     * - Lock file creation (after start, using returned PID)
     * - Output channel logging (via process stdout/stderr streams)
     */
    private async startServerForEnvironment(
        projectContext: ProjectContext,
        interpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        const fileKey = deepnoteFileUri.fsPath;
        const interpreterId = interpreter.id;

        Cancellation.throwIfCanceled(token);

        // Check if deepnote-toolkit is installed, and install if needed
        logger.info(`Checking deepnote-toolkit installation for interpreter ${interpreterId}...`);
        const isInstalled = await this.installer.isInstalled(Product.deepnoteToolkit, interpreter);

        if (!isInstalled) {
            logger.info(`deepnote-toolkit not installed, installing via IInstaller...`);
            const cts = new CancellationTokenSource();
            let cancellationListener: IDisposable | undefined;

            try {
                if (token) {
                    cancellationListener = token.onCancellationRequested(() => cts.cancel());
                }

                const result = await this.installer.install(Product.deepnoteToolkit, interpreter, cts);

                if (result === InstallerResponse.Cancelled) {
                    throw new Error('deepnote-toolkit installation was cancelled by the user');
                } else if (result !== InstallerResponse.Installed) {
                    throw new Error('Failed to install deepnote-toolkit. Check the Output panel for details.');
                }
            } finally {
                cancellationListener?.dispose();
                cts.dispose();
            }
        }

        this.agentSkillsManager.ensureSkillsUpdated(interpreterId, interpreter);

        Cancellation.throwIfCanceled(token);

        // Derive the environment path from the interpreter
        const envPath = this.deriveEnvPath(interpreter);

        logger.info(`Starting deepnote-toolkit server for ${fileKey} (interpreter ${interpreterId})`);
        this.outputChannel.appendLine(l10n.t('Starting Deepnote server...'));

        const extraEnv: Record<string, string> = {};

        await applyIntegrationEndpointEnv({
            deepnoteFileUri,
            endpoint: this.userpodApiEndpoints,
            extraEnv
        });

        // Initialize output tracking for error reporting
        this.serverOutputByFile.set(fileKey, { stdout: '', stderr: '' });

        let serverInfo: DeepnoteServerInfo | undefined;
        try {
            serverInfo = await startServer({
                pythonEnv: envPath,
                workingDirectory: path.dirname(deepnoteFileUri.fsPath),
                startupTimeoutMs: SERVER_STARTUP_TIMEOUT_MS,
                env: extraEnv
            });
        } catch (error) {
            const capturedOutput = this.serverOutputByFile.get(fileKey);
            this.serverOutputByFile.delete(fileKey);

            throw new DeepnoteServerStartupError(
                interpreter.uri.fsPath,
                0,
                'unknown',
                capturedOutput?.stdout || '',
                capturedOutput?.stderr || '',
                error instanceof Error ? error : new Error(`${error}`)
            );
        }

        projectContext.serverInfo = serverInfo;

        // Set up output channel logging from the server process
        this.monitorServerOutput(fileKey, serverInfo);

        // Write lock file for orphan-cleanup tracking
        const serverPid = serverInfo.process.pid;
        if (serverPid) {
            await this.writeLockFile(serverPid);
        } else {
            logger.warn(`Could not get PID for server process for ${fileKey}`);
        }

        logger.info(`Deepnote server started successfully at ${serverInfo.url} for ${fileKey}`);
        this.outputChannel.appendLine(l10n.t('✓ Deepnote server running at {0}', serverInfo.url));

        return serverInfo;
    }

    /**
     * Derive the environment path from a Python interpreter.
     * Uses the cached environment info, or falls back to navigating up from the executable.
     */
    private deriveEnvPath(interpreter: PythonEnvironment): string {
        const cachedEnv = getCachedEnvironment(interpreter);
        // eslint-disable-next-line local-rules/dont-use-fspath
        const folderPath = cachedEnv?.environment?.folderUri?.fsPath;

        if (folderPath) {
            return folderPath;
        }

        const sysPrefix = cachedEnv?.executable?.sysPrefix;

        if (sysPrefix) {
            return sysPrefix;
        }

        // Fallback: go up from bin/python (or Scripts/python.exe on Windows)
        return path.dirname(path.dirname(interpreter.uri.fsPath));
    }

    /**
     * Stop the server using @deepnote/runtime-core's `stopServer` (SIGTERM -> wait -> SIGKILL).
     */
    private async stopServerForEnvironment(
        projectContext: ProjectContext,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<void> {
        const fileKey = deepnoteFileUri.fsPath;

        Cancellation.throwIfCanceled(token);

        const { serverInfo } = projectContext;

        if (serverInfo) {
            const serverPid = serverInfo.process.pid;

            try {
                logger.info(`Stopping Deepnote server for ${fileKey}...`);
                await stopServer(serverInfo);
                this.outputChannel.appendLine(l10n.t('Deepnote server stopped for {0}', fileKey));
            } catch (ex) {
                logger.error('Error stopping Deepnote server', ex);
            } finally {
                projectContext.serverInfo = null;

                if (serverPid) {
                    await this.deleteLockFile(serverPid);
                }
            }
        }

        Cancellation.throwIfCanceled(token);

        this.serverOutputByFile.delete(fileKey);

        const disposables = this.disposablesByFile.get(fileKey);
        if (disposables) {
            disposables.forEach((d) => d.dispose());
            this.disposablesByFile.delete(fileKey);
        }
    }

    /**
     * Check if a server is still running by probing its /api endpoint.
     */
    private async isServerRunning(serverInfo: DeepnoteServerInfo): Promise<boolean> {
        try {
            const response = await fetch(`${serverInfo.url}/api`, { signal: AbortSignal.timeout(5000) });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Stream stdout/stderr from the server process to the VSCode output channel.
     */
    private monitorServerOutput(fileKey: string, serverInfo: DeepnoteServerInfo): void {
        const proc = serverInfo.process;
        const disposables: IDisposable[] = [];
        this.disposablesByFile.set(fileKey, disposables);

        if (proc.stdout) {
            const stdout = proc.stdout;
            const onData = (data: Buffer) => {
                const text = data.toString();
                logger.trace(`Deepnote server (${fileKey}): ${text}`);
                this.outputChannel.appendLine(text);

                const outputTracking = this.serverOutputByFile.get(fileKey);
                if (outputTracking) {
                    outputTracking.stdout = (outputTracking.stdout + text).slice(-MAX_OUTPUT_TRACKING_LENGTH);
                }
            };
            stdout.on('data', onData);
            disposables.push({
                dispose: () => {
                    stdout.off('data', onData);
                }
            });
        }

        if (proc.stderr) {
            const stderr = proc.stderr;
            const onData = (data: Buffer) => {
                const text = data.toString();
                logger.warn(`Deepnote server stderr (${fileKey}): ${text}`);
                this.outputChannel.appendLine(text);

                const outputTracking = this.serverOutputByFile.get(fileKey);
                if (outputTracking) {
                    outputTracking.stderr = (outputTracking.stderr + text).slice(-MAX_OUTPUT_TRACKING_LENGTH);
                }
            };
            stderr.on('data', onData);
            disposables.push({
                dispose: () => {
                    stderr.off('data', onData);
                }
            });
        }
    }

    public async dispose(): Promise<void> {
        logger.info('Disposing DeepnoteServerStarter - stopping all servers...');

        const pendingOps = Array.from(this.pendingOperations.values());
        if (pendingOps.length > 0) {
            logger.info(`Waiting for ${pendingOps.length} pending operations to complete...`);
            await Promise.allSettled(
                pendingOps.map((op) => Promise.race([op.promise, sleep(GRACEFUL_SHUTDOWN_TIMEOUT_MS)]))
            );
        }

        const stopPromises: Promise<void>[] = [];
        const pidsToCleanup: number[] = [];

        for (const [key, ctx] of this.projectContexts.entries()) {
            if (ctx.serverInfo) {
                const pid = ctx.serverInfo.process.pid;
                if (pid) {
                    pidsToCleanup.push(pid);
                }

                logger.info(`Stopping Deepnote server for ${key}...`);
                stopPromises.push(
                    stopServer(ctx.serverInfo).catch((ex) => {
                        logger.error(`Error stopping Deepnote server for ${key}`, ex);
                    })
                );
            }
        }

        if (stopPromises.length > 0) {
            logger.info(`Waiting for ${stopPromises.length} server processes to exit...`);
            await Promise.allSettled(stopPromises);
        }

        for (const pid of pidsToCleanup) {
            await this.deleteLockFile(pid);
        }

        for (const [fileKey, disposables] of this.disposablesByFile.entries()) {
            try {
                disposables.forEach((d) => d.dispose());
            } catch (ex) {
                logger.error(`Error disposing resources for ${fileKey}`, ex);
            }
        }

        this.disposablesByFile.clear();
        this.pendingOperations.clear();
        this.projectContexts.clear();
        this.serverOutputByFile.clear();

        logger.info('DeepnoteServerStarter disposed successfully');
    }

    // ── Lock file management (extension-specific) ──

    private async initializeLockFileDirectory(): Promise<void> {
        try {
            await fs.ensureDir(this.lockFileDir);
            logger.info(`Lock file directory initialized at ${this.lockFileDir} with session ID ${this.sessionId}`);
        } catch (ex) {
            logger.error('Failed to create lock file directory', ex);
        }
    }

    private getLockFilePath(pid: number): string {
        return path.join(this.lockFileDir, `server-${pid}.json`);
    }

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
            logger.warn(`Failed to write lock file for PID ${pid}`, ex);
        }
    }

    private async readLockFile(pid: number): Promise<ServerLockFile | null> {
        try {
            const lockFilePath = this.getLockFilePath(pid);
            if (await fs.pathExists(lockFilePath)) {
                return await fs.readJson(lockFilePath);
            }
        } catch (ex) {
            logger.warn(`Failed to read lock file for PID ${pid}`, ex);
        }
        return null;
    }

    private async deleteLockFile(pid: number): Promise<void> {
        try {
            const lockFilePath = this.getLockFilePath(pid);
            if (await fs.pathExists(lockFilePath)) {
                await fs.remove(lockFilePath);
                logger.info(`Deleted lock file for PID ${pid}`);
            }
        } catch (ex) {
            logger.warn(`Failed to delete lock file for PID ${pid}`, ex);
        }
    }

    // ── Orphaned process cleanup (extension-specific) ──

    private async isProcessOrphaned(pid: number): Promise<boolean> {
        try {
            const processService = await this.processServiceFactory.create(undefined);

            if (process.platform === 'win32') {
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
                            if (ppid === 0) {
                                return true;
                            }

                            const parentCheck = await processService.exec(
                                'tasklist',
                                ['/FI', `PID eq ${ppid}`, '/FO', 'CSV', '/NH'],
                                { throwOnStdErr: false }
                            );

                            const stdout = (parentCheck.stdout || '').trim();

                            if (stdout.length === 0 || /^INFO:/i.test(stdout) || /no tasks are running/i.test(stdout)) {
                                return true;
                            }

                            return false;
                        }
                    }
                }
            } else {
                const result = await processService.exec('ps', ['-o', 'ppid=', '-p', pid.toString()], {
                    throwOnStdErr: false
                });

                if (result.stdout) {
                    const ppid = parseInt(result.stdout.trim(), 10);
                    if (!isNaN(ppid)) {
                        if (ppid === 1) {
                            return true;
                        }

                        const parentCheck = await processService.exec('ps', ['-p', ppid.toString(), '-o', 'pid='], {
                            throwOnStdErr: false
                        });
                        return parentCheck.stdout.trim().length === 0;
                    }
                }
            }
        } catch (ex) {
            logger.warn(`Failed to check if process ${pid} is orphaned`, ex);
        }

        return false;
    }

    private async cleanupOrphanedProcesses(): Promise<void> {
        try {
            logger.info('Checking for orphaned deepnote-toolkit processes...');
            const processService = await this.processServiceFactory.create(undefined);

            let command: string;
            let args: string[];

            if (process.platform === 'win32') {
                command = 'tasklist';
                args = ['/FI', 'IMAGENAME eq python.exe', '/FO', 'CSV', '/NH'];
            } else {
                command = 'ps';
                args = ['aux'];
            }

            const result = await processService.exec(command, args, { throwOnStdErr: false });

            if (result.stdout) {
                const lines = result.stdout.split('\n');
                const candidatePids: number[] = [];

                for (const line of lines) {
                    if (line.includes('deepnote_toolkit') && line.includes('server')) {
                        let pid: number | undefined;

                        if (process.platform === 'win32') {
                            const match = line.match(/"python\.exe","(\d+)"/);
                            if (match) {
                                pid = parseInt(match[1], 10);
                            }
                        } else {
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

                    for (const pid of candidatePids) {
                        const lockData = await this.readLockFile(pid);

                        if (lockData) {
                            if (lockData.sessionId !== this.sessionId) {
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
                                pidsToSkip.push({ pid, reason: 'belongs to current session' });
                            }
                        } else {
                            pidsToSkip.push({ pid, reason: 'no lock file (assuming external process)' });
                        }
                    }

                    if (pidsToSkip.length > 0) {
                        for (const { pid, reason } of pidsToSkip) {
                            logger.info(`Skipping PID ${pid}: ${reason}`);
                        }
                    }

                    if (pidsToKill.length > 0) {
                        logger.info(`Killing ${pidsToKill.length} orphaned process(es): ${pidsToKill.join(', ')}`);
                        this.outputChannel.appendLine(
                            l10n.t('Cleaning up {0} orphaned deepnote-toolkit process(es)...', pidsToKill.length)
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

                                await this.deleteLockFile(pid);
                            } catch (ex) {
                                logger.warn(`Failed to kill process ${pid}`, ex);
                            }
                        }

                        this.outputChannel.appendLine(l10n.t('✓ Cleanup complete'));
                    } else {
                        logger.info('No orphaned deepnote-toolkit processes found (all processes are active)');
                    }
                } else {
                    logger.info('No deepnote-toolkit server processes found');
                }
            }
        } catch (ex) {
            logger.warn('Error during orphaned process cleanup', ex);
        }
    }
}
