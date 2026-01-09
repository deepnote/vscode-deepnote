import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';
import { inject, injectable, optional } from 'inversify';
import { NotebookCell, Uri, workspace } from 'vscode';

import type { Environment, Execution, ExecutionError } from '@deepnote/blocks';

import { IEnvironmentCapture } from './environmentCapture.node';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { notebookCellExecutions, NotebookCellExecutionState } from '../../platform/notebooks/cellExecutionStateService';
import { ISnapshotMetadataService as IPlatformSnapshotMetadataService } from '../../platform/notebooks/deepnote/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { ISnapshotFileService } from './snapshotFileServiceTypes';

class TimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
    }
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
 * Used by SnapshotMetadataService to aggregate execution data.
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

/**
 * Service interface for tracking and retrieving snapshot metadata.
 * Extends the platform interface with additional methods for the notebooks layer.
 */
export { ISnapshotMetadataService } from '../../platform/notebooks/deepnote/types';

export interface ISnapshotMetadataServiceFull extends IPlatformSnapshotMetadataService {
    /**
     * Get block-level execution metadata for a specific cell.
     */
    getBlockExecutionMetadata(notebookUri: string, cellId: string): BlockExecutionMetadata | undefined;

    /**
     * Get environment metadata for a notebook.
     * If capture is in progress, waits for it to complete before returning.
     */
    getEnvironmentMetadata(notebookUri: string): Promise<Environment | undefined>;

    /**
     * Get execution metadata for a notebook.
     */
    getExecutionMetadata(notebookUri: string): Execution | undefined;

    /**
     * Record the end of a cell execution.
     */
    recordCellExecutionEnd(
        notebookUri: string,
        cellId: string,
        endTime: number,
        success: boolean,
        error?: ExecutionError
    ): void;

    /**
     * Record the start of a cell execution.
     */
    recordCellExecutionStart(notebookUri: string, cellId: string, startTime: number): void;
}

/**
 * Service that tracks and aggregates execution metadata for notebooks.
 * This service captures:
 * - Per-cell execution timing (startedAt, finishedAt)
 * - Notebook-level execution summary (blocksExecuted, blocksSucceeded, etc.)
 * - Environment metadata (captured once per execution session)
 */
@injectable()
export class SnapshotMetadataService implements ISnapshotMetadataServiceFull, IExtensionSyncActivationService {
    private readonly converter = new DeepnoteDataConverter();
    private readonly executionStates = new Map<string, NotebookExecutionState>();
    private readonly runAllModeNotebooks = new Set<string>();

    constructor(
        @inject(IEnvironmentCapture) private readonly environmentCapture: IEnvironmentCapture,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IDeepnoteNotebookManager) @optional() private readonly notebookManager?: IDeepnoteNotebookManager,
        @inject(ISnapshotFileService) @optional() private readonly snapshotFileService?: ISnapshotFileService
    ) {}

    activate(): void {
        logger.info('[Snapshot] SnapshotMetadataService activated');

        workspace.onDidCloseNotebookDocument(
            (notebook) => {
                this.clearExecutionState(notebook.uri.toString());
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
        this.runAllModeNotebooks.delete(notebookUri);

        logger.trace(`[Snapshot] Cleared execution state for ${notebookUri}`);
    }

    isRunAllMode(notebookUri: string): boolean {
        return this.runAllModeNotebooks.has(notebookUri);
    }

    async onExecutionComplete(notebookUri: string): Promise<void> {
        logger.debug(`[Snapshot] onExecutionComplete called for ${notebookUri}`);

        // Check if snapshots are enabled
        if (!this.snapshotFileService?.isSnapshotsEnabled()) {
            logger.debug(`[Snapshot] Snapshots not enabled, skipping`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Find the notebook document
        const notebook = workspace.notebookDocuments.find((n) => n.uri.toString() === notebookUri);

        if (!notebook) {
            logger.warn(`[Snapshot] Could not find notebook document for ${notebookUri}`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Get project ID from notebook metadata
        const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;

        if (!projectId) {
            logger.warn(`[Snapshot] No project ID in notebook metadata`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Get project data from notebook manager
        const originalProject = this.notebookManager?.getOriginalProject(projectId);

        if (!originalProject) {
            logger.warn(`[Snapshot] No original project found for ${projectId}`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Find the project URI
        const projectUri = this.findProjectUriFromId(projectId);

        if (!projectUri) {
            logger.warn(`[Snapshot] Could not find project URI for ${projectId}`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Get current notebook ID
        const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;

        if (!notebookId) {
            logger.warn(`[Snapshot] No notebook ID in notebook metadata`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Find the notebook in the project
        const deepnoteNotebook = originalProject.project.notebooks?.find((nb) => nb.id === notebookId);

        if (!deepnoteNotebook) {
            logger.warn(`[Snapshot] Notebook ${notebookId} not found in project`);
            this.runAllModeNotebooks.delete(notebookUri);

            return;
        }

        // Convert current VS Code cells to blocks with outputs
        // Map NotebookCell to NotebookCellData format expected by converter
        const cellData = notebook.getCells().map((cell) => ({
            kind: cell.kind,
            value: cell.document.getText(),
            languageId: cell.document.languageId,
            metadata: cell.metadata,
            outputs: [...cell.outputs]
        }));
        const blocks = this.converter.convertCellsToBlocks(cellData);

        // Prepare snapshot project data
        const snapshotProject = structuredClone(originalProject) as DeepnoteFile;
        const snapshotNotebook = snapshotProject.project.notebooks?.find((nb) => nb.id === notebookId);

        if (snapshotNotebook) {
            snapshotNotebook.blocks = blocks as DeepnoteBlock[];
        }

        // Determine snapshot type based on runAll mode
        const isRunAll = this.runAllModeNotebooks.has(notebookUri);

        if (isRunAll) {
            // Full snapshot (timestamped + latest)
            logger.debug(`[Snapshot] Creating full snapshot (Run All mode)`);

            const snapshotUri = await this.snapshotFileService.createSnapshot(
                projectUri,
                projectId,
                originalProject.project.name,
                snapshotProject
            );

            if (snapshotUri) {
                logger.info(`[Snapshot] Created full snapshot: ${snapshotUri.toString()}`);
            }
        } else {
            // Partial snapshot (latest only)
            logger.debug(`[Snapshot] Updating latest snapshot only (partial run)`);

            const snapshotUri = await this.snapshotFileService.updateLatestSnapshot(
                projectUri,
                projectId,
                originalProject.project.name,
                snapshotProject
            );

            if (snapshotUri) {
                logger.info(`[Snapshot] Updated latest snapshot: ${snapshotUri.toString()}`);
            }
        }

        // Clear the runAll flag after handling
        this.runAllModeNotebooks.delete(notebookUri);
    }

    setRunAllMode(notebookUri: string): void {
        this.runAllModeNotebooks.add(notebookUri);

        logger.debug(`[Snapshot] Set Run All mode for ${notebookUri}`);
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

        // Environment is captured before execution starts via captureEnvironmentBeforeExecution()
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

    recordCellExecutionEnd(
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

    recordCellExecutionStart(notebookUri: string, cellId: string, startTime: number): void {
        const state = this.getOrCreateExecutionState(notebookUri, startTime);
        const isoTimestamp = new Date(startTime).toISOString();

        // Create or update cell metadata
        const cellMetadata = state.cellMetadata.get(cellId) || { contentHash: '' };

        cellMetadata.executionStartedAt = isoTimestamp;

        delete cellMetadata.executionFinishedAt;

        state.cellMetadata.set(cellId, cellMetadata);

        logger.trace(`[Snapshot] Cell ${cellId} execution started at ${isoTimestamp}`);
    }

    /**
     * Updates the content hash for a cell.
     * Called during serialization when we compute the hash.
     */
    updateContentHash(notebookUri: string, cellId: string, contentHash: string): void {
        const state = this.executionStates.get(notebookUri);

        if (!state) {
            return;
        }

        const cellMetadata = state.cellMetadata.get(cellId) || {
            contentHash: '',
            executionFinishedAt: undefined,
            executionStartedAt: undefined
        };
        cellMetadata.contentHash = contentHash;
        state.cellMetadata.set(cellId, cellMetadata);
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
            // Find the notebook document to get its resource for interpreter resolution
            const notebook = workspace.notebookDocuments.find((n) => n.uri.toString() === notebookUri);

            if (!notebook) {
                logger.info(`[Snapshot] Could not find notebook document for ${notebookUri}`);
                logger.info(
                    `[Snapshot] Available notebooks: ${workspace.notebookDocuments
                        .map((d) => d.uri.toString())
                        .join(', ')}`
                );
                state.environmentCaptured = true; // Mark as captured to prevent retries

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

            // Mark as captured only after completion (success or failure)
            state.environmentCaptured = true;
        } catch (error) {
            logger.error('[Snapshot] Failed to capture environment', error);
            state.environmentCaptured = true; // Mark as captured to prevent retries
        }
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

    private findProjectUriFromId(projectId: string): Uri | undefined {
        const notebookDoc = workspace.notebookDocuments.find(
            (doc) => doc.notebookType === 'deepnote' && doc.metadata?.deepnoteProjectId === projectId
        );

        return notebookDoc?.uri.with({ query: '' });
    }

    private handleCellExecutionStateChange(cell: NotebookCell, state: NotebookCellExecutionState): void {
        const notebookUri = cell.notebook.uri.toString();
        const cellId = cell.metadata?.id as string | undefined;

        if (!cellId) {
            return;
        }

        if (state === NotebookCellExecutionState.Executing) {
            // Cell started executing - record start time
            const startTime = Date.now();
            this.recordCellExecutionStart(notebookUri, cellId, startTime);
        } else if (state === NotebookCellExecutionState.Idle) {
            // Cell finished executing - record end time and success/failure
            const endTime = Date.now();
            const executionSummary = cell.executionSummary;

            // Use VSCode's timing if available (more accurate)
            const actualEndTime = executionSummary?.timing?.endTime || endTime;

            // Determine success based on execution summary
            // If success is undefined, treat as success (cell may have had no output)
            const success = executionSummary?.success !== false;

            this.recordCellExecutionEnd(notebookUri, cellId, actualEndTime, success);
        }
    }
}
