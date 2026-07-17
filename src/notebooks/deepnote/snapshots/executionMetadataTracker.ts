import { injectable } from 'inversify';

import type { Execution, ExecutionError } from '@deepnote/blocks';

import { logger } from '../../../platform/logging';

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
 * Per-notebook cell-execution state. Holds only the execution-timing/counter concern;
 * environment capture lives separately on the service.
 */
interface TrackedExecution {
    /** Number of blocks executed so far */
    blocksExecuted: number;

    /** Number of blocks that failed */
    blocksFailed: number;

    /** Number of blocks that succeeded */
    blocksSucceeded: number;

    /** Per-cell execution metadata, keyed by cell ID */
    cellMetadata: Map<string, BlockExecutionMetadata>;

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
 * Owns per-notebook cell-execution metadata: timing, counters, per-cell state, and the
 * derived execution summary. Kept separate from environment capture so the two concerns
 * do not share one mutable struct.
 */
@injectable()
export class ExecutionMetadataTracker {
    private readonly executionStates = new Map<string, TrackedExecution>();

    clear(notebookUri: string): void {
        this.executionStates.delete(notebookUri);
    }

    /**
     * Returns the tracked state for a notebook, creating a fresh session (counters zeroed,
     * `startedAt` seeded from `startTime`) if none exists. Existing state is preserved so a
     * capture-time seed is not overwritten by a later first-cell start.
     */
    ensureExecutionState(notebookUri: string, startTime: number): void {
        if (this.executionStates.has(notebookUri)) {
            return;
        }

        this.executionStates.set(notebookUri, {
            blocksFailed: 0,
            blocksExecuted: 0,
            blocksSucceeded: 0,
            cellMetadata: new Map(),
            startedAt: new Date(startTime).toISOString(),
            totalDurationMs: 0
        });

        logger.trace(`[Snapshot] Created new execution state for ${notebookUri}`);
    }

    getBlockExecutionMetadata(notebookUri: string, cellId: string): BlockExecutionMetadata | undefined {
        const state = this.executionStates.get(notebookUri);

        if (!state) {
            return;
        }

        return state.cellMetadata.get(cellId);
    }

    /**
     * Number of blocks executed for a notebook, or `undefined` when the notebook is untracked.
     * The undefined/number distinction lets callers avoid conflating "no session" with "zero blocks".
     */
    getExecutedBlockCount(notebookUri: string): number | undefined {
        return this.executionStates.get(notebookUri)?.blocksExecuted;
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

    /**
     * Whether any tracked cell started execution but has not finished yet.
     */
    hasPendingCellStateChanges(notebookUri: string): boolean {
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
        this.ensureExecutionState(notebookUri, startTime);

        const state = this.executionStates.get(notebookUri)!;
        const isoTimestamp = new Date(startTime).toISOString();
        const cellMetadata = state.cellMetadata.get(cellId) || { contentHash: '' };

        cellMetadata.executionStartedAt = isoTimestamp;

        delete cellMetadata.executionFinishedAt;

        state.cellMetadata.set(cellId, cellMetadata);

        logger.trace(`[Snapshot] Cell ${cellId} execution started at ${isoTimestamp}`);
    }
}
