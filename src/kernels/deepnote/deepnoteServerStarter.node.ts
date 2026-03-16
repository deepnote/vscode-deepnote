/**
 * @deepnote/runtime-core functions not currently exported that would be useful:
 * - findConsecutiveAvailablePorts(startPort) — duplicated logic for multi-server port reservation
 * - waitForServer(info, timeoutMs) — health-check polling on /api
 * - createJsonWebSocketFactory() — forces JSON-only Jupyter WS protocol, potential stability improvement
 * - ExecutionEngine.toPythonLiteral(value) — JS-to-Python literal conversion
 */

import * as fs from 'fs-extra';
import { inject, injectable, named, optional } from 'inversify';
import * as os from 'os';
import { CancellationToken, l10n, Uri } from 'vscode';

import { startServer, stopServer } from '@deepnote/runtime-core';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { Cancellation } from '../../platform/common/cancellation';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IDisposable, IOutputChannel } from '../../platform/common/types';
import { sleep } from '../../platform/common/utils/async';
import { generateUuid } from '../../platform/common/uuid';
import { DeepnoteServerStartupError } from '../../platform/errors/deepnoteKernelErrors';
import { logger } from '../../platform/logging';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import * as path from '../../platform/vscode-path/path';
import { DeepnoteServerInfo, IDeepnoteServerStarter, IDeepnoteToolkitInstaller } from './types';
import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';

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
    environmentId: string;
    serverInfo: DeepnoteServerInfo | null;
}

/**
 * Starts and manages the deepnote-toolkit Jupyter server.
 *
 * Uses @deepnote/runtime-core's `startServer`/`stopServer` for the core server
 * lifecycle (process spawn, port discovery, health checks, shutdown), and layers
 * extension-specific concerns on top: lock files, orphan cleanup, SQL integration
 * env vars, output channel logging, and multi-server concurrency control.
 */
@injectable()
export class DeepnoteServerStarter implements IDeepnoteServerStarter, IExtensionSyncActivationService {
    private readonly disposablesByFile: Map<string, IDisposable[]> = new Map();
    private readonly projectContexts: Map<string, ProjectContext> = new Map();
    private readonly pendingOperations: Map<string, PendingOperation> = new Map();
    private portAllocationLock: Promise<void> = Promise.resolve();
    private readonly sessionId: string = generateUuid();
    private readonly lockFileDir: string = path.join(os.tmpdir(), 'vscode-deepnote-locks');

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(DeepnoteAgentSkillsManager) private readonly agentSkillsManager: DeepnoteAgentSkillsManager,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry,
        @inject(ISqlIntegrationEnvVarsProvider)
        @optional()
        private readonly sqlIntegrationEnvVars?: ISqlIntegrationEnvVarsProvider
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
        venvPath: Uri,
        managedVenv: boolean,
        additionalPackages: string[],
        environmentId: string,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        const fileKey = deepnoteFileUri.fsPath;
        const serverKey = `${fileKey}-${environmentId}`;

        let pendingOp = this.pendingOperations.get(serverKey);
        if (pendingOp) {
            logger.info(`Waiting for pending operation on ${serverKey} to complete...`);
            try {
                await pendingOp.promise;
            } catch {
                // Ignore errors from previous operations
            }
        }

        let existingContext = this.projectContexts.get(serverKey);
        if (existingContext != null) {
            const { environmentId: existingEnvironmentId, serverInfo: existingServerInfo } = existingContext;

            if (existingEnvironmentId === environmentId) {
                if (existingServerInfo != null && (await this.isServerRunning(existingServerInfo))) {
                    logger.info(`Deepnote server already running at ${existingServerInfo.url} for ${serverKey}`);
                    return existingServerInfo;
                }

                pendingOp = this.pendingOperations.get(serverKey);

                if (pendingOp && pendingOp.type === 'start') {
                    return await pendingOp.promise;
                }
            } else {
                logger.info(
                    `Stopping existing server for ${serverKey} with environmentId ${existingEnvironmentId} to start new one with environmentId ${environmentId}...`
                );
                await this.stopServerForEnvironment(existingContext, deepnoteFileUri, token);
            }
        } else {
            const newContext: ProjectContext = {
                environmentId,
                serverInfo: null
            };

            this.projectContexts.set(serverKey, newContext);
            existingContext = newContext;
        }

        const operation = {
            type: 'start' as const,
            promise: this.startServerForEnvironment(
                existingContext,
                interpreter,
                venvPath,
                managedVenv,
                additionalPackages,
                environmentId,
                deepnoteFileUri,
                token
            )
        };
        this.pendingOperations.set(serverKey, operation);

        try {
            const result = await operation.promise;

            existingContext.serverInfo = result;
            return result;
        } finally {
            if (this.pendingOperations.get(serverKey) === operation) {
                this.pendingOperations.delete(serverKey);
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
     * - Toolkit/venv installation (before start)
     * - SQL integration env var injection (via ServerOptions.env)
     * - Lock file creation (after start, using returned PID)
     * - Output channel logging (via process stdout/stderr streams)
     * - Port allocation serialization across concurrent starts
     */
    private async startServerForEnvironment(
        projectContext: ProjectContext,
        interpreter: PythonEnvironment,
        venvPath: Uri,
        managedVenv: boolean,
        additionalPackages: string[],
        environmentId: string,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<DeepnoteServerInfo> {
        const fileKey = deepnoteFileUri.fsPath;
        const serverKey = `${fileKey}-${environmentId}`;

        Cancellation.throwIfCanceled(token);

        logger.info(`Ensuring deepnote-toolkit is installed in venv for environment ${environmentId}...`);
        const { pythonInterpreter: venvInterpreter } = await this.toolkitInstaller.ensureVenvAndToolkit(
            interpreter,
            venvPath,
            managedVenv,
            token
        );

        this.agentSkillsManager.ensureSkillsUpdated(environmentId, venvInterpreter);

        Cancellation.throwIfCanceled(token);

        await this.toolkitInstaller.installAdditionalPackages(venvPath, additionalPackages, token);

        Cancellation.throwIfCanceled(token);

        // Serialize port allocation across concurrent server starts
        const port = await this.reserveStartPort(serverKey);

        logger.info(
            `Starting deepnote-toolkit server on port ${port} for ${serverKey} with environmentId ${environmentId}`
        );
        this.outputChannel.appendLine(l10n.t('Starting Deepnote server on port {0}...', port));

        // Gather SQL integration env vars to pass to the server
        const extraEnv = await this.gatherSqlIntegrationEnvVars(deepnoteFileUri, environmentId, token);

        let serverInfo: DeepnoteServerInfo;
        try {
            serverInfo = await startServer({
                pythonEnv: venvPath.fsPath,
                workingDirectory: path.dirname(deepnoteFileUri.fsPath),
                port,
                startupTimeoutMs: SERVER_STARTUP_TIMEOUT_MS,
                env: extraEnv
            });
        } catch (error) {
            throw new DeepnoteServerStartupError(
                interpreter.uri.fsPath,
                port,
                'unknown',
                '',
                error instanceof Error ? error.message : String(error),
                error instanceof Error ? error : undefined
            );
        }

        projectContext.serverInfo = serverInfo;

        // Set up output channel logging from the server process
        this.monitorServerOutput(serverKey, serverInfo);

        // Write lock file for orphan-cleanup tracking
        const serverPid = serverInfo.process.pid;
        if (serverPid) {
            await this.writeLockFile(serverPid);
        } else {
            logger.warn(`Could not get PID for server process for ${serverKey}`);
        }

        logger.info(`Deepnote server started successfully at ${serverInfo.url} for ${serverKey}`);
        this.outputChannel.appendLine(l10n.t('✓ Deepnote server running at {0}', serverInfo.url));

        return serverInfo;
    }

    /**
     * Stop the server using @deepnote/runtime-core's `stopServer` (SIGTERM -> wait -> SIGKILL).
     */
    private async stopServerForEnvironment(
        projectContext: ProjectContext | null,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<void> {
        const fileKey = deepnoteFileUri.fsPath;

        Cancellation.throwIfCanceled(token);

        const serverInfo = projectContext?.serverInfo;

        if (serverInfo) {
            const serverPid = serverInfo.process.pid;

            try {
                logger.info(`Stopping Deepnote server for ${fileKey}...`);
                await stopServer(serverInfo);
                this.outputChannel.appendLine(l10n.t('Deepnote server stopped for {0}', fileKey));
            } catch (ex) {
                logger.error('Error stopping Deepnote server', ex);
            } finally {
                if (projectContext) {
                    projectContext.serverInfo = null;
                }

                if (serverPid) {
                    await this.deleteLockFile(serverPid);
                }
            }
        }

        Cancellation.throwIfCanceled(token);

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
            const response = await fetch(`${serverInfo.url}/api`);
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Serialize port reservation across concurrent server starts.
     *
     * runtime-core's `startServer` finds its own consecutive ports, but when multiple
     * servers start concurrently in the extension, they can race. This lock serializes
     * the starts so each `startServer` call sees the ports bound by previous calls.
     */
    private async reserveStartPort(serverKey: string): Promise<number> {
        const previousLock = this.portAllocationLock;
        let releaseLock: () => void;
        const currentLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });
        this.portAllocationLock = previousLock.then(() => currentLock);

        await previousLock;

        try {
            // Collect ports already in use by running servers to pick a non-conflicting start port
            let maxPort = 8888;
            for (const ctx of this.projectContexts.values()) {
                if (ctx.serverInfo) {
                    maxPort = Math.max(maxPort, ctx.serverInfo.jupyterPort + 2, ctx.serverInfo.lspPort + 1);
                }
            }

            logger.info(`Reserved start port ${maxPort} for ${serverKey}`);
            return maxPort;
        } finally {
            releaseLock!();
        }
    }

    /**
     * Gather SQL integration environment variables for the deepnote-toolkit server.
     */
    private async gatherSqlIntegrationEnvVars(
        deepnoteFileUri: Uri,
        environmentId: string,
        token?: CancellationToken
    ): Promise<Record<string, string>> {
        const extraEnv: Record<string, string> = {};

        if (!this.sqlIntegrationEnvVars) {
            logger.debug('DeepnoteServerStarter: SqlIntegrationEnvironmentVariablesProvider not available');
            return extraEnv;
        }

        const fileKey = deepnoteFileUri.fsPath;

        logger.debug(
            `DeepnoteServerStarter: Injecting SQL integration env vars for ${fileKey} with environmentId ${environmentId}`
        );
        try {
            const sqlEnvVars = await this.sqlIntegrationEnvVars.getEnvironmentVariables(deepnoteFileUri, token);
            if (sqlEnvVars && Object.keys(sqlEnvVars).length > 0) {
                logger.debug(`DeepnoteServerStarter: Injecting ${Object.keys(sqlEnvVars).length} SQL env vars`);
                Object.assign(extraEnv, sqlEnvVars);
            } else {
                logger.debug('DeepnoteServerStarter: No SQL integration env vars to inject');
            }
        } catch (error) {
            logger.error('DeepnoteServerStarter: Failed to get SQL integration env vars', error);
        }

        return extraEnv;
    }

    /**
     * Stream stdout/stderr from the server process to the VSCode output channel.
     */
    private monitorServerOutput(serverKey: string, serverInfo: DeepnoteServerInfo): void {
        const proc = serverInfo.process;
        const disposables: IDisposable[] = [];
        this.disposablesByFile.set(serverKey, disposables);

        if (proc.stdout) {
            const stdout = proc.stdout;
            const onData = (data: Buffer) => {
                const text = data.toString();
                logger.trace(`Deepnote server (${serverKey}): ${text}`);
                this.outputChannel.appendLine(text);
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
                logger.warn(`Deepnote server stderr (${serverKey}): ${text}`);
                this.outputChannel.appendLine(text);
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
            await Promise.allSettled(pendingOps.map((op) => Promise.race([op, sleep(GRACEFUL_SHUTDOWN_TIMEOUT_MS)])));
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

        this.projectContexts.clear();
        this.disposablesByFile.clear();
        this.pendingOperations.clear();

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
