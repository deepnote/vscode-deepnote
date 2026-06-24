import {
    deserializeDeepnoteFile,
    isExecutableBlock,
    serializeDeepnoteFile,
    type DeepnoteBlock,
    type DeepnoteFile,
    type Environment,
    type Execution,
    type ExecutionError
} from '@deepnote/blocks';
import { countBlocksWithOutputs, hasOutputs } from '@deepnote/convert';
import fastDeepEqual from 'fast-deep-equal';
import { inject, injectable, optional } from 'inversify';
import {
    Disposable,
    FileType,
    NotebookCell,
    NotebookCellKind,
    NotebookDocumentChangeEvent,
    RelativePattern,
    Uri,
    window,
    workspace
} from 'vscode';
import { Utils } from 'vscode-uri';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import type { DeepnoteOutput } from '../../../platform/deepnote/deepnoteTypes';
import { InvalidProjectNameError } from '../../../platform/errors/invalidProjectNameError';
import {
    generateSnapshotFilename,
    parseSnapshotFilename,
    resolveSnapshotNotebookId,
    slugifyProjectName
} from './snapshotFiles';
import { logger } from '../../../platform/logging';
import {
    notebookCellExecutions,
    NotebookCellExecutionState
} from '../../../platform/notebooks/cellExecutionStateService';
import { IDeepnoteNotebookManager } from '../../types';
import { DeepnoteDataConverter } from '../deepnoteDataConverter';
import { IEnvironmentCapture } from './environmentCapture.node';

/**
 * Platform-layer interface for snapshot metadata service.
 * Used by the kernel execution layer to capture environment before cell execution.
 */
export const ISnapshotMetadataService = Symbol('ISnapshotMetadataService');
export interface ISnapshotMetadataService {
    /**
     * Capture environment before execution starts.
     * Called at the start of a cell execution batch.
     * This is blocking and should complete before cells execute.
     */
    captureEnvironmentBeforeExecution(notebookUri: string): Promise<void>;

    /**
     * Clear execution state for a notebook (e.g., when kernel restarts).
     */
    clearExecutionState(notebookUri: string): void;
}

/**
 * Block-level execution metadata.
 */
export interface BlockExecutionMetadata {
    /** SHA-256 hash of block source code (prefixed with "sha256:") */
    contentHash: string;

    /** ISO 8601 timestamp when block execution started */
    executionStartedAt?: string;

    /** ISO 8601 timestamp when block execution completed */
    executionFinishedAt?: string;
}

/**
 * Internal state tracking for a notebook execution session.
 */
interface NotebookExecutionState {
    /** Number of blocks executed so far */
    blocksExecuted: number;

    /** Number of blocks that failed */
    blocksFailed: number;

    /** Number of blocks that succeeded */
    blocksSucceeded: number;

    /** Promise that resolves when environment capture completes */
    capturePromise?: Promise<void>;

    /** Per-cell execution metadata, keyed by cell ID */
    cellMetadata: Map<string, BlockExecutionMetadata>;

    /** Cached environment metadata */
    environment?: Environment;

    /** Whether environment has been captured for this session */
    environmentCaptured: boolean;

    /** Top-level error if any */
    error?: { name?: string; message?: string; traceback?: string[] };

    /** ISO 8601 timestamp when last cell finished executing */
    finishedAt?: string;

    /** ISO 8601 timestamp when first cell started executing */
    startedAt: string;

    /** Total duration in milliseconds */
    totalDurationMs: number;
}

/** How long a written URI is considered "recent" and suppressed from file-change processing. */
const recentWriteExpirationMs = 2000;

/**
 * After execution completes, wait for outputs to settle before writing a snapshot. The timer is
 * (re)armed on each output/metadata-bearing notebook change and only flushes once this quiet
 * window elapses with no further changes.
 */
const outputSettleQuietPeriodMs = 150;

/**
 * Upper bound, measured from the first arm, on how long the deferred snapshot save can be pushed
 * out by repeated output/metadata changes. Once exceeded, the save flushes regardless.
 */
const outputSettleMaxWaitMs = 2000;

/** Maximum number of snapshot files the open-time (path-free) reader inspects per workspace folder. */
const maxSnapshotFilesPerFolder = 200;

class TimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
    }
}

/**
 * Generates a timestamp string for snapshot filenames.
 * Format: 2025-12-11T10-31-48 (ISO 8601 with colons replaced by hyphens)
 */
function generateTimestamp(): string {
    return new Date().toISOString().replace(/:/g, '-').slice(0, 19);
}

/**
 * Unified service for managing Deepnote notebook snapshots.
 * Handles both file I/O operations (reading/writing snapshot files) and
 * execution metadata tracking (timing, environment capture).
 */
@injectable()
export class SnapshotService implements ISnapshotMetadataService, IExtensionSyncActivationService {
    private readonly converter = new DeepnoteDataConverter();
    private readonly executionStates = new Map<string, NotebookExecutionState>();
    private readonly fileWrittenCallbacks: ((uri: Uri) => void)[] = [];
    private readonly pendingSnapshotSaves = new Map<
        string,
        { armedAt: number; timer: ReturnType<typeof setTimeout> }
    >();
    private readonly recentlyWrittenTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly recentlyWrittenUris = new Set<string>();

    constructor(
        @inject(IEnvironmentCapture) private readonly environmentCapture: IEnvironmentCapture,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IDeepnoteNotebookManager) @optional() private readonly notebookManager?: IDeepnoteNotebookManager
    ) {}

    activate(): void {
        logger.info('[Snapshot] SnapshotService activated');

        this.disposables.push({
            dispose: () => {
                for (const timer of this.recentlyWrittenTimers.values()) {
                    clearTimeout(timer);
                }
                this.recentlyWrittenTimers.clear();

                // Cancel any in-flight deferred snapshot saves so timers don't fire after disposal.
                for (const pending of this.pendingSnapshotSaves.values()) {
                    clearTimeout(pending.timer);
                }
                this.pendingSnapshotSaves.clear();
            }
        });

        workspace.onDidCloseNotebookDocument(
            (notebook) => {
                const notebookUri = notebook.uri.toString();

                this.cancelPendingSnapshotSave(notebookUri);
                this.clearExecutionState(notebookUri);
            },
            this,
            this.disposables
        );

        workspace.onDidChangeNotebookDocument(
            (e) => {
                this.handleNotebookDocumentChange(e);
            },
            this,
            this.disposables
        );

        notebookCellExecutions.onDidChangeNotebookCellExecutionState(
            (e) => {
                logger.debug(`[Snapshot] Cell execution state changed: ${e.state} for cell ${e.cell.metadata?.id}`);
                this.handleCellExecutionStateChange(e.cell, e.state);
            },
            this,
            this.disposables
        );

        notebookCellExecutions.onDidCompleteQueueExecution(
            (e) => {
                logger.debug(`[Snapshot] Queue execution complete for ${e.notebookUri}`);
                this.onExecutionComplete(e.notebookUri);
            },
            this,
            this.disposables
        );
    }

    async captureEnvironmentBeforeExecution(notebookUri: string): Promise<void> {
        logger.info(`[Snapshot] captureEnvironmentBeforeExecution called for ${notebookUri}`);

        const state = this.getOrCreateExecutionState(notebookUri, Date.now());

        // If capture is already in progress, wait for it
        if (state.capturePromise) {
            logger.info(`[Snapshot] Capture already in progress, waiting...`);
            await state.capturePromise;

            return;
        }

        // Start capture and store the promise so other callers can wait for it
        state.capturePromise = this.captureEnvironmentForNotebook(notebookUri);
    }

    clearExecutionState(notebookUri: string): void {
        this.executionStates.delete(notebookUri);

        logger.trace(`[Snapshot] Cleared execution state for ${notebookUri}`);
    }

    async createSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile,
        notebookId?: string,
        notebookUri?: string
    ): Promise<Uri | undefined> {
        const prepared = await this.prepareSnapshotData(
            projectUri,
            projectId,
            projectName,
            projectData,
            notebookId,
            notebookUri
        );

        if (!prepared) {
            logger.debug(`[Snapshot] No changes detected, skipping snapshot creation`);

            return;
        }

        const { latestPath, content } = prepared;
        const timestamp = generateTimestamp();
        const timestampedPath = this.buildSnapshotPath(projectUri, projectId, projectName, timestamp, notebookId);

        // Write to timestamped file first (safe - doesn't touch existing files)
        try {
            await workspace.fs.writeFile(timestampedPath, content);
            this.trackWrittenUri(timestampedPath);
            logger.debug(`[Snapshot] Wrote timestamped snapshot: ${Utils.basename(timestampedPath)}`);
        } catch (error) {
            logger.error(`[Snapshot] Failed to write timestamped snapshot: ${Utils.basename(timestampedPath)}`, error);

            const message = error instanceof Error ? error.message : String(error);

            await window.showErrorMessage(`Failed to create snapshot: ${message}`);

            return;
        }

        // Copy timestamped file to 'latest' pointer
        try {
            await workspace.fs.copy(timestampedPath, latestPath, { overwrite: true });
            this.trackWrittenUri(latestPath);

            logger.debug(`[Snapshot] Updated latest snapshot: ${Utils.basename(latestPath)}`);
        } catch (error) {
            logger.warn(
                `[Snapshot] Wrote timestamped snapshot but failed to update latest pointer: ${Utils.basename(
                    latestPath
                )}. ` + `Timestamped snapshot available at: ${Utils.basename(timestampedPath)}`,
                error
            );

            const message = error instanceof Error ? error.message : String(error);

            await window.showErrorMessage(`Failed to update latest snapshot pointer: ${message}`);

            return;
        }

        return timestampedPath;
    }

    extractOutputsFromBlocks(blocks: DeepnoteBlock[]): Map<string, DeepnoteOutput[]> {
        const outputsMap = new Map<string, DeepnoteOutput[]>();

        for (const block of blocks) {
            if (block.id && isExecutableBlock(block) && block.outputs) {
                outputsMap.set(block.id, block.outputs as DeepnoteOutput[]);
            }
        }

        return outputsMap;
    }

    getBlockExecutionMetadata(notebookUri: string, cellId: string): BlockExecutionMetadata | undefined {
        const state = this.executionStates.get(notebookUri);

        if (!state) {
            return;
        }

        return state.cellMetadata.get(cellId);
    }

    async getEnvironmentMetadata(notebookUri: string): Promise<Environment | undefined> {
        const state = this.executionStates.get(notebookUri);

        logger.info(`[Snapshot] getEnvironmentMetadata for ${notebookUri}`);
        logger.info(Boolean(state) ? '[Snapshot] State exists.' : '[Snapshot] No state found.');

        if (!state) {
            logger.info(`[Snapshot] Available URIs: ${Array.from(this.executionStates.keys()).join(', ')}`);

            return;
        }

        // If capture is in progress, wait for it to complete
        if (state.capturePromise && !state.environmentCaptured) {
            logger.info(`[Snapshot] Waiting for capture to complete before returning metadata.`);

            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => reject(new TimeoutError('Timeout waiting for environment capture.')), 10_000);
            });

            await Promise.race([state.capturePromise, timeoutPromise]).catch((error) => {
                if (error instanceof TimeoutError) {
                    logger.warn('[Snapshot] Timed out waiting for environment capture');
                } else {
                    throw error;
                }
            });
        }

        logger.info(`[Snapshot] state.environment exists: ${!!state.environment}`);
        logger.info(`[Snapshot] state.environmentCaptured: ${state.environmentCaptured}`);

        return state.environment;
    }

    getExecutionMetadata(notebookUri: string): Execution | undefined {
        const state = this.executionStates.get(notebookUri);

        if (!state) {
            return;
        }

        // Don't return execution metadata if no cells have been executed
        if (state.blocksExecuted === 0) {
            return;
        }

        const execution: Execution = {
            finishedAt: state.finishedAt || state.startedAt,
            startedAt: state.startedAt,
            summary: {
                blocksExecuted: state.blocksExecuted,
                blocksFailed: state.blocksFailed,
                blocksSucceeded: state.blocksSucceeded,
                totalDurationMs: state.totalDurationMs
            },
            triggeredBy: 'user'
        };

        if (state.error) {
            execution.error = state.error;
        }

        return execution;
    }

    isSnapshotsEnabled(): boolean {
        const config = workspace.getConfiguration('deepnote');

        return config.get<boolean>('snapshots.enabled', true);
    }

    mergeOutputsIntoBlocks(blocks: DeepnoteBlock[], outputs: Map<string, DeepnoteOutput[]>): DeepnoteBlock[] {
        let mergedCount = 0;

        const mergedBlocks = blocks.map((block) => {
            if (!block.id) {
                return block;
            }

            const blockOutputs = outputs.get(block.id);

            if (blockOutputs !== undefined) {
                mergedCount++;

                return { ...block, outputs: blockOutputs };
            }

            return block;
        });

        logger.debug(`[Snapshot] Merged outputs into ${mergedCount}/${blocks.length} blocks`);

        return mergedBlocks;
    }

    /**
     * Registers a callback that is invoked whenever this service writes a file.
     * Used by the file change watcher for deterministic self-write detection.
     */
    onFileWritten(callback: (uri: Uri) => void): Disposable {
        this.fileWrittenCallbacks.push(callback);

        return {
            dispose: () => {
                const idx = this.fileWrittenCallbacks.indexOf(callback);
                if (idx >= 0) {
                    this.fileWrittenCallbacks.splice(idx, 1);
                }
            }
        };
    }

    /**
     * Reads the best available snapshot for a project/notebook WITHOUT a file path.
     *
     * `deserializeNotebook` only receives the file bytes (no URI), so this resolver globs the
     * workspace for snapshot files keyed on `projectId` ONLY, parses each basename with convert's
     * pure `parseSnapshotFilename`, ranks them (notebook-scoped match first, legacy no-notebook-id
     * entries kept as a fallback, then `latest`, then newest timestamp), and walks the ranked
     * candidates returning the first one with real outputs. It never calls convert's path-bound
     * disk helpers (loadLatestSnapshot/findSnapshotsForProject/loadSnapshotFile/getSnapshotPath).
     */
    async readSnapshot(projectId: string, notebookId?: string): Promise<Map<string, DeepnoteOutput[]> | undefined> {
        logger.debug(`[Snapshot] readSnapshot called for projectId=${projectId}, notebookId=${notebookId}`);
        const workspaceFolders = workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            logger.debug(`[Snapshot] No workspace folders found`);

            await window.showWarningMessage('Cannot read snapshot: No workspace folders found.');

            return;
        }

        logger.debug(`[Snapshot] Searching ${workspaceFolders.length} workspace folder(s) for snapshots`);

        // Key the glob on projectId only — the percent-encoded notebook id must NOT be embedded so
        // that legacy (no-notebook-id) snapshots are still discovered and can serve as a fallback.
        const glob = `**/snapshots/*_${projectId}_*.snapshot.deepnote`;
        const candidates: Array<{ uri: Uri; notebookId?: string; timestamp: string }> = [];

        for (const folder of workspaceFolders) {
            const pattern = new RelativePattern(folder, glob);
            const files = await workspace.findFiles(pattern, null, maxSnapshotFilesPerFolder);

            for (const uri of files) {
                const basename = Utils.basename(uri);
                const parsed = parseSnapshotFilename(basename);

                if (!parsed || parsed.projectId !== projectId) {
                    continue;
                }

                // Drop OTHER notebooks' scoped files; keep this notebook's scoped files and all
                // legacy no-notebook-id files (the latter act as a backward-compatible fallback).
                if (notebookId && parsed.notebookId && parsed.notebookId !== notebookId) {
                    continue;
                }

                candidates.push({ uri, notebookId: parsed.notebookId, timestamp: parsed.timestamp });
            }
        }

        if (candidates.length === 0) {
            logger.debug(`[Snapshot] No snapshot files found for project ${projectId}`);

            return;
        }

        candidates.sort((a, b) => this.compareSnapshotCandidates(a, b, notebookId));

        // Walk the ranked candidates: skip a corrupt file or an empty-output `latest` (a block→[]
        // mapping signals a save race) and continue; return the first candidate with real outputs.
        for (const candidate of candidates) {
            let file: DeepnoteFile;

            try {
                const content = await workspace.fs.readFile(candidate.uri);
                const contentString = new TextDecoder('utf-8').decode(content);

                file = deserializeDeepnoteFile(contentString);
            } catch (error) {
                logger.warn(
                    `[Snapshot] Failed to read/parse snapshot candidate: ${Utils.basename(candidate.uri)}`,
                    error
                );

                continue;
            }

            if (candidate.timestamp === 'latest' && countBlocksWithOutputs(file) === 0) {
                logger.debug(
                    `[Snapshot] Skipping empty-output latest snapshot (possible save race): ${Utils.basename(
                        candidate.uri
                    )}`
                );

                continue;
            }

            if (!hasOutputs(file)) {
                logger.debug(
                    `[Snapshot] Snapshot candidate has no outputs, trying next: ${Utils.basename(candidate.uri)}`
                );

                continue;
            }

            logger.debug(`[Snapshot] Using snapshot: ${Utils.basename(candidate.uri)}`);

            return this.extractOutputsFromFile(file);
        }

        logger.debug(`[Snapshot] No snapshot candidate with real outputs found for project ${projectId}`);

        return;
    }

    stripOutputsFromBlocks(blocks: DeepnoteBlock[]): DeepnoteBlock[] {
        return blocks.map((block) => {
            if (!isExecutableBlock(block)) {
                return { ...block };
            }

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { outputs, executionCount, executionFinishedAt, executionStartedAt, ...strippedBlock } = block;

            return strippedBlock as DeepnoteBlock;
        });
    }

    /**
     * Checks whether a URI was recently written by this extension.
     * Used by the file change watcher to skip processing self-triggered changes.
     */
    wasRecentlyWritten(uri: Uri): boolean {
        return this.recentlyWrittenUris.has(uri.toString());
    }

    private buildSnapshotPath(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        variant: 'latest' | string,
        notebookId?: string
    ): Uri {
        const parentDir = Uri.joinPath(projectUri, '..');

        // convert's slugifyProjectName returns '' (rather than throwing) for names with no
        // slug-safe characters; preserve the existing "skip snapshots for invalid names" contract
        // by validating here so prepareSnapshotData can catch InvalidProjectNameError.
        if (typeof projectName !== 'string' || !projectName.trim()) {
            throw new InvalidProjectNameError();
        }

        const slug = slugifyProjectName(projectName);

        if (!slug) {
            throw new InvalidProjectNameError();
        }

        const filename = generateSnapshotFilename({ slug, projectId, notebookId, timestamp: variant });

        return Uri.joinPath(parentDir, 'snapshots', filename);
    }

    private async captureEnvironmentForNotebook(notebookUri: string): Promise<void> {
        logger.info(`[Snapshot] captureEnvironmentForNotebook called for ${notebookUri}`);

        const state = this.executionStates.get(notebookUri);

        if (!state) {
            logger.info(`[Snapshot] Skipping capture: no state found`);

            return;
        }

        if (state.environmentCaptured) {
            logger.info(`[Snapshot] Skipping capture: already captured`);

            return;
        }

        try {
            const notebook = workspace.notebookDocuments.find((n) => n.uri.toString() === notebookUri);

            if (!notebook) {
                logger.info(`[Snapshot] Could not find notebook document for ${notebookUri}`);
                logger.info(
                    `[Snapshot] Available notebooks: ${workspace.notebookDocuments
                        .map((d) => d.uri.toString())
                        .join(', ')}`
                );
                state.environmentCaptured = true;

                return;
            }

            logger.info(`[Snapshot] Found notebook, getting interpreter...`);

            const environment = await this.environmentCapture.captureEnvironment(notebook.uri);

            if (environment) {
                state.environment = environment;
                logger.info(`[Snapshot] Captured environment successfully for ${notebookUri}`);
            } else {
                logger.info(`[Snapshot] environmentCapture returned undefined`);
            }

            state.environmentCaptured = true;
        } catch (error) {
            logger.error('[Snapshot] Failed to capture environment', error);
            state.environmentCaptured = true;
        }
    }

    private async ensureSnapshotsDirectory(snapshotsDir: Uri): Promise<boolean> {
        try {
            const stat = await workspace.fs.stat(snapshotsDir);

            if (stat.type !== FileType.Directory) {
                logger.error(
                    `[Snapshot] Snapshots path exists but is not a directory: ${Utils.basename(snapshotsDir)}`
                );

                return false;
            }

            return true;
        } catch {
            logger.debug(`[Snapshot] Creating snapshots directory: ${Utils.basename(snapshotsDir)}`);

            try {
                await workspace.fs.createDirectory(snapshotsDir);

                return true;
            } catch (error) {
                logger.error(`[Snapshot] Failed to create snapshots directory: ${Utils.basename(snapshotsDir)}`, error);

                return false;
            }
        }
    }

    private findProjectUriFromId(projectId: string): Uri | undefined {
        const notebookDoc = workspace.notebookDocuments.find(
            (doc) => doc.notebookType === 'deepnote' && doc.metadata?.deepnoteProjectId === projectId
        );

        return notebookDoc?.uri;
    }

    private getComparableProjectContent(data: DeepnoteFile): object {
        return {
            version: data.version,
            project: data.project,
            environment: data.environment,
            execution: data.execution
        };
    }

    private getOrCreateExecutionState(notebookUri: string, startTime: number): NotebookExecutionState {
        let state = this.executionStates.get(notebookUri);

        if (!state) {
            state = {
                blocksFailed: 0,
                blocksExecuted: 0,
                blocksSucceeded: 0,
                cellMetadata: new Map(),
                environmentCaptured: false,
                startedAt: new Date(startTime).toISOString(),
                totalDurationMs: 0
            };
            this.executionStates.set(notebookUri, state);
            logger.trace(`[Snapshot] Created new execution state for ${notebookUri}`);
        }

        return state;
    }

    private handleCellExecutionStateChange(cell: NotebookCell, state: NotebookCellExecutionState): void {
        const notebookUri = cell.notebook.uri.toString();
        const cellId = cell.metadata?.id as string | undefined;

        if (!cellId) {
            return;
        }

        if (state === NotebookCellExecutionState.Executing) {
            const startTime = Date.now();

            // A new execution invalidates any deferred save armed by the previous run; the new
            // run will re-arm on completion. This prevents writing a snapshot mid-execution.
            this.cancelPendingSnapshotSave(notebookUri);
            this.recordCellExecutionStart(notebookUri, cellId, startTime);
        } else if (state === NotebookCellExecutionState.Idle) {
            const endTime = Date.now();
            const executionSummary = cell.executionSummary;
            const actualEndTime = executionSummary?.timing?.endTime || endTime;
            const success = executionSummary?.success !== false;

            this.recordCellExecutionEnd(notebookUri, cellId, actualEndTime, success);
        }
    }

    private async hasSnapshotChanges(latestPath: Uri, projectData: DeepnoteFile): Promise<boolean> {
        try {
            const existingContent = await workspace.fs.readFile(latestPath);
            const existingString = new TextDecoder('utf-8').decode(existingContent);
            const existingData = deserializeDeepnoteFile(existingString);

            const existingProject = this.getComparableProjectContent(existingData);
            const newProject = this.getComparableProjectContent(projectData);

            return !fastDeepEqual(existingProject, newProject);
        } catch {
            logger.debug(`[Snapshot] No existing snapshot found, treating as changed`);

            return true;
        }
    }

    /**
     * Checks if there are any cells with pending execution state changes.
     * Returns true if any tracked cell started execution but hasn't finished yet.
     */
    private hasPendingCellStateChanges(notebookUri: string): boolean {
        const state = this.executionStates.get(notebookUri);

        if (!state) {
            return false;
        }

        for (const metadata of state.cellMetadata.values()) {
            if (metadata.executionStartedAt && !metadata.executionFinishedAt) {
                return true;
            }
        }

        return false;
    }

    /**
     * Waits for pending cell state change events to be processed.
     * Uses an event-driven approach with a fallback timeout.
     */
    private waitForPendingCellStateChanges(notebookUri: string, timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            // If no pending changes, resolve immediately
            if (!this.hasPendingCellStateChanges(notebookUri)) {
                resolve();

                return;
            }

            // Set up a one-time listener for cell state changes
            const disposable = notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                if (e.cell.notebook.uri.toString() === notebookUri && e.state === NotebookCellExecutionState.Idle) {
                    // Check if all pending cells are now complete
                    if (!this.hasPendingCellStateChanges(notebookUri)) {
                        disposable.dispose();
                        resolve();
                    }
                }
            });

            // Fallback timeout to prevent hanging indefinitely
            setTimeout(() => {
                disposable.dispose();
                resolve();
            }, timeoutMs);
        });
    }

    /**
     * Arms (or re-arms) the output-settled deferred snapshot save for a notebook. The save flushes
     * once `outputSettleQuietPeriodMs` elapses with no further output/metadata-bearing change, but
     * never later than `outputSettleMaxWaitMs` from the first arm.
     */
    private armSnapshotSave(notebookUri: string): void {
        const now = Date.now();
        const existing = this.pendingSnapshotSaves.get(notebookUri);
        const armedAt = existing ? existing.armedAt : now;

        if (existing) {
            clearTimeout(existing.timer);
        }

        // Bound the quiet-period reset by the max wait measured from the first arm.
        const remainingMaxWait = Math.max(0, armedAt + outputSettleMaxWaitMs - now);
        const delay = Math.min(outputSettleQuietPeriodMs, remainingMaxWait);

        const timer = setTimeout(() => {
            this.pendingSnapshotSaves.delete(notebookUri);
            void this.performSnapshotSave(notebookUri);
        }, delay);

        this.pendingSnapshotSaves.set(notebookUri, { armedAt, timer });
    }

    private cancelPendingSnapshotSave(notebookUri: string): void {
        const existing = this.pendingSnapshotSaves.get(notebookUri);

        if (existing) {
            clearTimeout(existing.timer);
            this.pendingSnapshotSaves.delete(notebookUri);

            logger.debug(`[Snapshot] Cancelled pending snapshot save for ${notebookUri}`);
        }
    }

    private handleNotebookDocumentChange(event: NotebookDocumentChangeEvent): void {
        const notebookUri = event.notebook.uri.toString();

        // Only matters while a save is pending; re-arm the settle timer when outputs/metadata change.
        if (!this.pendingSnapshotSaves.has(notebookUri)) {
            return;
        }

        const bearsOutputOrMetadata = event.cellChanges.some(
            (change) =>
                change.outputs !== undefined || change.executionSummary !== undefined || change.metadata !== undefined
        );

        if (bearsOutputOrMetadata) {
            logger.trace(`[Snapshot] Output/metadata change while save pending — re-arming settle timer`);
            this.armSnapshotSave(notebookUri);
        }
    }

    private async onExecutionComplete(notebookUri: string): Promise<void> {
        logger.debug(`[Snapshot] onExecutionComplete called for ${notebookUri}`);

        // Wait for any pending cell state change events to be processed.
        // This is needed because the queue completion event can fire before the
        // last cell's Idle state change event has been processed (race condition).
        await this.waitForPendingCellStateChanges(notebookUri, 100);

        if (!this.isSnapshotsEnabled()) {
            logger.debug(`[Snapshot] Snapshots not enabled, skipping`);

            return;
        }

        // Defer the actual write until outputs settle (see armSnapshotSave). A new execution
        // re-entering the executing state, notebook close, or disposal cancels the pending save.
        this.armSnapshotSave(notebookUri);
    }

    /**
     * Performs the deferred snapshot save: rebuilds the notebook's blocks, detects Run All vs
     * partial run, and writes the snapshot. "Run all" → timestamped + latest; partial → latest only.
     */
    private async performSnapshotSave(notebookUri: string): Promise<void> {
        logger.debug(`[Snapshot] performSnapshotSave for ${notebookUri}`);

        if (!this.isSnapshotsEnabled()) {
            logger.debug(`[Snapshot] Snapshots not enabled, skipping`);

            return;
        }

        const notebook = workspace.notebookDocuments.find((n) => n.uri.toString() === notebookUri);

        if (!notebook) {
            logger.warn(`[Snapshot] Could not find notebook document for ${notebookUri}`);

            return;
        }

        const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;

        if (!projectId) {
            logger.warn(`[Snapshot] No project ID in notebook metadata`);

            return;
        }

        const originalProject = this.notebookManager?.getAnyProjectEntry(projectId);

        if (!originalProject) {
            logger.warn(`[Snapshot] No original project found for ${projectId}`);

            return;
        }

        const projectUri = this.findProjectUriFromId(projectId);

        if (!projectUri) {
            logger.warn(`[Snapshot] Could not find project URI for ${projectId}`);

            return;
        }

        const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;

        if (!notebookId) {
            logger.warn(`[Snapshot] No notebook ID in notebook metadata`);

            return;
        }

        const deepnoteNotebook = originalProject.project.notebooks?.find((nb) => nb.id === notebookId);

        if (!deepnoteNotebook) {
            logger.warn(`[Snapshot] Notebook ${notebookId} not found in project`);

            return;
        }

        const cellData = notebook.getCells().map((cell) => ({
            kind: cell.kind,
            value: cell.document.getText(),
            languageId: cell.document.languageId,
            metadata: cell.metadata,
            outputs: [...cell.outputs]
        }));
        const blocks = this.converter.convertCellsToBlocks(cellData);

        const snapshotProject = structuredClone(originalProject) as DeepnoteFile;
        const snapshotNotebook = snapshotProject.project.notebooks?.find((nb) => nb.id === notebookId);

        if (snapshotNotebook) {
            snapshotNotebook.blocks = blocks as DeepnoteBlock[];
        }

        // The snapshot filename is scoped by the file's snapshot notebook id (single-notebook file →
        // its one notebook; [init, main] → the main notebook), falling back to the rendered
        // notebook's metadata id for any unexpected multi-notebook shape.
        const snapshotNotebookId = resolveSnapshotNotebookId(snapshotProject) ?? notebookId;

        // Detect "Run All" by checking if all code cells in the notebook were executed
        const state = this.executionStates.get(notebookUri);
        const totalCodeCells = notebook.getCells().filter((cell) => cell.kind === NotebookCellKind.Code).length;
        const isRunAll = state && state.blocksExecuted === totalCodeCells;

        if (isRunAll) {
            logger.debug(`[Snapshot] Creating full snapshot (Run All mode)`);

            const snapshotUri = await this.createSnapshot(
                projectUri,
                projectId,
                originalProject.project.name,
                snapshotProject,
                snapshotNotebookId,
                notebookUri
            );

            if (snapshotUri) {
                logger.info(`[Snapshot] Created full snapshot: ${snapshotUri.toString()}`);
            }
        } else {
            logger.debug(`[Snapshot] Updating latest snapshot only (partial run)`);

            const snapshotUri = await this.updateLatestSnapshot(
                projectUri,
                projectId,
                originalProject.project.name,
                snapshotProject,
                snapshotNotebookId,
                notebookUri
            );

            if (snapshotUri) {
                logger.info(`[Snapshot] Updated latest snapshot: ${snapshotUri.toString()}`);
            }
        }

        // Clear execution state so the next run starts fresh
        this.clearExecutionState(notebookUri);
    }

    /**
     * Ranking comparator for open-time snapshot candidates (reimplemented locally from convert's
     * `findSnapshotsForProject` ordering, since the path-bound convert helper cannot run here):
     * the requested notebook's scoped match first, then `latest`, then newest timestamp. Legacy
     * no-notebook-id entries are NOT dropped — they sort after the scoped match as a fallback.
     */
    private compareSnapshotCandidates(
        a: { notebookId?: string; timestamp: string },
        b: { notebookId?: string; timestamp: string },
        notebookId?: string
    ): number {
        if (notebookId) {
            const aMatches = a.notebookId === notebookId;

            if (aMatches !== (b.notebookId === notebookId)) {
                return aMatches ? -1 : 1;
            }
        }

        const aLatest = a.timestamp === 'latest';

        if (aLatest !== (b.timestamp === 'latest')) {
            return aLatest ? -1 : 1;
        }

        return b.timestamp.localeCompare(a.timestamp);
    }

    private extractOutputsFromFile(file: DeepnoteFile): Map<string, DeepnoteOutput[]> {
        const outputsMap = new Map<string, DeepnoteOutput[]>();
        let totalBlocks = 0;

        for (const notebook of file.project.notebooks) {
            for (const block of notebook.blocks) {
                totalBlocks++;
                try {
                    if (isExecutableBlock(block) && block.outputs) {
                        outputsMap.set(block.id, block.outputs as DeepnoteOutput[]);
                    }
                } catch (blockError) {
                    logger.warn(`[Snapshot] Failed to extract outputs for block ${block.id}`, blockError);
                }
            }
        }

        logger.debug(`[Snapshot] Extracted ${outputsMap.size} block outputs from ${totalBlocks} total blocks`);

        return outputsMap;
    }

    private async prepareSnapshotData(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile,
        notebookId?: string,
        notebookUri?: string
    ): Promise<{ latestPath: Uri; content: Uint8Array } | undefined> {
        let latestPath: Uri;

        try {
            latestPath = this.buildSnapshotPath(projectUri, projectId, projectName, 'latest', notebookId);
        } catch (error) {
            if (error instanceof InvalidProjectNameError) {
                logger.warn('[Snapshot] Skipping snapshots due to invalid project name', error);

                return;
            }
            throw error;
        }

        const snapshotsDir = Uri.joinPath(latestPath, '..');
        const dirExists = await this.ensureSnapshotsDirectory(snapshotsDir);

        if (!dirExists) {
            return;
        }

        const hasChanges = await this.hasSnapshotChanges(latestPath, projectData);

        if (!hasChanges) {
            return;
        }

        const snapshotData = structuredClone(projectData);

        snapshotData.metadata = snapshotData.metadata || {};
        if (!snapshotData.metadata.createdAt) {
            snapshotData.metadata.createdAt = new Date().toISOString();
        }
        snapshotData.metadata.modifiedAt = new Date().toISOString();

        // Add environment and execution metadata to snapshot
        if (notebookUri) {
            const executionMetadata = this.getExecutionMetadata(notebookUri);

            if (executionMetadata) {
                snapshotData.execution = executionMetadata;
            }

            const environmentMetadata = await this.getEnvironmentMetadata(notebookUri);

            if (environmentMetadata) {
                snapshotData.environment = environmentMetadata;
            }
        }

        const yamlString = serializeDeepnoteFile(snapshotData);
        const content = new TextEncoder().encode(yamlString);

        return { latestPath, content };
    }

    private recordCellExecutionEnd(
        notebookUri: string,
        cellId: string,
        endTime: number,
        success: boolean,
        error?: ExecutionError
    ): void {
        const state = this.executionStates.get(notebookUri);

        if (!state) {
            logger.warn(`[Snapshot] No execution state found for notebook ${notebookUri}`);

            return;
        }

        const isoTimestamp = new Date(endTime).toISOString();
        const cellMetadata = state.cellMetadata.get(cellId);

        if (cellMetadata) {
            cellMetadata.executionFinishedAt = isoTimestamp;
        }

        state.blocksExecuted++;

        if (success) {
            state.blocksSucceeded++;
        } else {
            state.blocksFailed++;

            if (error) {
                state.error = error;
            }
        }

        state.finishedAt = isoTimestamp;

        const startMs = new Date(state.startedAt).getTime();

        state.totalDurationMs = endTime - startMs;

        logger.trace(`[Snapshot] Cell ${cellId} execution ended at ${isoTimestamp} (success: ${success})`);
    }

    private recordCellExecutionStart(notebookUri: string, cellId: string, startTime: number): void {
        const state = this.getOrCreateExecutionState(notebookUri, startTime);
        const isoTimestamp = new Date(startTime).toISOString();
        const cellMetadata = state.cellMetadata.get(cellId) || { contentHash: '' };

        cellMetadata.executionStartedAt = isoTimestamp;

        delete cellMetadata.executionFinishedAt;

        state.cellMetadata.set(cellId, cellMetadata);

        logger.trace(`[Snapshot] Cell ${cellId} execution started at ${isoTimestamp}`);
    }

    private trackWrittenUri(uri: Uri): void {
        const key = uri.toString();
        this.recentlyWrittenUris.add(key);

        const existing = this.recentlyWrittenTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        this.recentlyWrittenTimers.set(
            key,
            setTimeout(() => {
                this.recentlyWrittenUris.delete(key);
                this.recentlyWrittenTimers.delete(key);
            }, recentWriteExpirationMs)
        );

        for (const callback of this.fileWrittenCallbacks) {
            try {
                callback(uri);
            } catch (error) {
                logger.warn('[Snapshot] File written callback failed', error);
            }
        }
    }

    private async updateLatestSnapshot(
        projectUri: Uri,
        projectId: string,
        projectName: string,
        projectData: DeepnoteFile,
        notebookId?: string,
        notebookUri?: string
    ): Promise<Uri | undefined> {
        const prepared = await this.prepareSnapshotData(
            projectUri,
            projectId,
            projectName,
            projectData,
            notebookId,
            notebookUri
        );

        if (!prepared) {
            logger.debug(`[Snapshot] No changes detected, skipping latest snapshot update`);

            return;
        }

        const { latestPath, content } = prepared;

        try {
            await workspace.fs.writeFile(latestPath, content);
            this.trackWrittenUri(latestPath);
            logger.debug(`[Snapshot] Updated latest snapshot: ${Utils.basename(latestPath)}`);

            return latestPath;
        } catch (error) {
            logger.error(`[Snapshot] Failed to update latest snapshot: ${Utils.basename(latestPath)}`, error);

            return;
        }
    }
}
