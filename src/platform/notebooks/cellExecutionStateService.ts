// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EventEmitter, workspace, type NotebookCell } from 'vscode';

import { logger } from '../logging';
import { trackDisposable } from '../common/utils/lifecycle';

/**
 * The execution state of a notebook cell.
 */
export enum NotebookCellExecutionState {
    /**
     * The cell is idle.
     */
    Idle = 1,
    /**
     * Execution for the cell is pending.
     */
    Pending = 2,
    /**
     * The cell is currently executing.
     */
    Executing = 3
}

/**
 * An event describing a cell execution state change.
 */
export interface NotebookCellExecutionStateChangeEvent {
    /**
     * The {@link NotebookCell cell} for which the execution state has changed.
     */
    readonly cell: NotebookCell;
    /**
     * The new execution state of the cell.
     */
    readonly state: NotebookCellExecutionState;
}

/**
 * An event describing completion of a notebook's cell execution queue.
 */
export interface NotebookQueueCompletionEvent {
    /**
     * The URI of the notebook whose execution queue has completed.
     */
    readonly notebookUri: string;
}

const STATE_NAMES: Record<NotebookCellExecutionState, string> = {
    [NotebookCellExecutionState.Idle]: 'Idle',
    [NotebookCellExecutionState.Pending]: 'Pending',
    [NotebookCellExecutionState.Executing]: 'Executing'
};

export namespace notebookCellExecutions {
    const eventEmitter = trackDisposable(new EventEmitter<NotebookCellExecutionStateChangeEvent>());
    const queueCompletionEmitter = trackDisposable(new EventEmitter<NotebookQueueCompletionEvent>());

    /**
     * An {@link Event} which fires when the execution state of a cell has changed.
     */
    // todo@API this is an event that is fired for a property that cells don't have and that makes me wonder
    // how a correct consumer works, e.g the consumer could have been late and missed an event?
    export const onDidChangeNotebookCellExecutionState = eventEmitter.event;

    /**
     * An {@link Event} which fires when a notebook's cell execution queue has completed.
     * This is fired after all queued cells have finished executing (success, error, or cancel).
     */
    export const onDidCompleteQueueExecution = queueCompletionEmitter.event;

    /**
     * Notify listeners that a notebook's cell execution queue has completed.
     * @param notebookUri The URI of the notebook whose queue completed
     */
    export function notifyQueueComplete(notebookUri: string) {
        logger.debug(`[CellExecState] Queue execution complete for ${notebookUri}`);
        queueCompletionEmitter.fire({ notebookUri });
    }

    export function changeCellState(cell: NotebookCell, state: NotebookCellExecutionState, executionOrder?: number) {
        const cellId = cell.metadata?.id as string | undefined;
        const stateName = STATE_NAMES[state] || String(state);

        logger.debug(
            `[CellExecState] changeCellState called: state=${stateName}, cellId=${cellId}, executionOrder=${executionOrder}`
        );

        if (state !== NotebookCellExecutionState.Idle || !executionOrder) {
            logger.debug(`[CellExecState] Firing event immediately for state=${stateName}`);
            eventEmitter.fire({ cell, state });
            return;
        }

        // Wait for the Editor to update the cell execution state before firing the event.
        logger.debug(`[CellExecState] Waiting for the Editor to update the cell before firing the "Idle" event.`);

        const disposable = trackDisposable(
            workspace.onDidChangeNotebookDocument((e) => {
                if (e.notebook !== cell.notebook) {
                    return;
                }
                const currentCellChange = e.cellChanges.find((c) => c.cell === cell);
                if (currentCellChange?.cell?.executionSummary?.executionOrder === executionOrder) {
                    logger.debug(`[CellExecState] Editor updated cell, firing Idle event for cellId=${cellId}`);
                    disposable.dispose();
                    eventEmitter.fire({ cell, state: NotebookCellExecutionState.Idle });
                }
            })
        );
    }
}
