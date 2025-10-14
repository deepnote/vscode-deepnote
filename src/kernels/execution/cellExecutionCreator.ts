// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    CancellationToken,
    CellExecutionError,
    NotebookCell,
    NotebookCellExecution,
    NotebookCellOutput,
    NotebookCellOutputItem
} from 'vscode';
import { logger } from '../../platform/logging';
import { IKernelController } from '../types';
import { noop } from '../../platform/common/utils/misc';
import { getNotebookTelemetryTracker } from '../telemetry/notebookTelemetry';

/**
 * Wrapper class around NotebookCellExecution that allows us to
 * - Call start more than once
 * - Do something when 'end' is called
 */
export class NotebookCellExecutionWrapper implements NotebookCellExecution {
    public _started: boolean = false;
    public get started() {
        return this._started;
    }
    private _startTime?: number;
    public errorInfo: CellExecutionError;
    /**
     * @param {boolean} [clearOutputOnStartWithTime=false] If true, clear the output when start is called with a time.
     */
    constructor(
        private readonly _impl: NotebookCellExecution,
        public controllerId: string,
        private _endCallback: (() => void) | undefined,
        private readonly clearOutputOnStartWithTime = false
    ) {}
    public get cell(): NotebookCell {
        return this._impl.cell;
    }
    public get token(): CancellationToken {
        return this._impl.token;
    }
    public get executionOrder(): number | undefined {
        return this._impl.executionOrder;
    }
    public set executionOrder(value: number | undefined) {
        if (value) {
            getNotebookTelemetryTracker(this._impl.cell.notebook)?.executeCellAcknowledged();
        }
        this._impl.executionOrder = value;
    }
    private startIfNecessary() {
        if (!this.started) {
            this._started = true;
            this._impl.start();
        }
    }
    start(startTime?: number): void {
        // Allow this to be called more than once (so we can switch out a kernel during running a cell)
        if (!this.started) {
            this._started = true;

            // Must call start() before clearOutput() per VS Code API requirements
            this._impl.start(startTime);
            this._startTime = startTime;

            // Clear outputs immediately after start if configured to do so
            // This ensures old outputs are removed before any new outputs arrive from the kernel
            if (this.clearOutputOnStartWithTime) {
                logger.trace(`Start cell ${this.cell.index} execution (clear output)`);
                this._impl.clearOutput().then(noop, noop);
            }

            if (startTime) {
                logger.trace(`Start cell ${this.cell.index} execution @ ${startTime}`);
            }
        }
    }
    end(success: boolean | undefined, endTime?: number): void {
        if (this._endCallback) {
            try {
                this._impl.end(success, endTime, this.errorInfo);
                logger.trace(
                    `Cell ${this.cell.index} completed in ${
                        ((endTime || 0) - (this._startTime || 0)) / 1000
                    }s (start: ${this._startTime}, end: ${endTime})`
                );
            } finally {
                this._endCallback();
                this._endCallback = undefined;
            }
        }
    }
    clearOutput(cell?: NotebookCell): Thenable<void> {
        this.startIfNecessary();
        return this._impl.clearOutput(cell);
    }
    replaceOutput(out: NotebookCellOutput | NotebookCellOutput[], cell?: NotebookCell): Thenable<void> {
        this.startIfNecessary();
        return this._impl.replaceOutput(out, cell);
    }
    appendOutput(out: NotebookCellOutput | NotebookCellOutput[], cell?: NotebookCell): Thenable<void> {
        this.startIfNecessary();
        return this._impl.appendOutput(out, cell);
    }
    replaceOutputItems(
        items: NotebookCellOutputItem | NotebookCellOutputItem[],
        output: NotebookCellOutput
    ): Thenable<void> {
        this.startIfNecessary();
        return this._impl.replaceOutputItems(items, output);
    }
    appendOutputItems(
        items: NotebookCellOutputItem | NotebookCellOutputItem[],
        output: NotebookCellOutput
    ): Thenable<void> {
        this.startIfNecessary();
        return this._impl.appendOutputItems(items, output);
    }
}

/**
 * Class for mapping cells to an instance of a NotebookCellExecution object
 */
export class CellExecutionCreator {
    private static _map = new WeakMap<NotebookCell, NotebookCellExecutionWrapper>();
    static getOrCreate(cell: NotebookCell, controller: IKernelController, clearOutputOnStartWithTime = false) {
        const existingExecution = this.get(cell);

        if (existingExecution) {
            // Always end and replace existing executions.
            // VS Code's NotebookCellExecution API doesn't support reuse - once end() is called,
            // you cannot call start(), clearOutput(), or any other methods on it again.
            // This handles both controller changes and re-executions.
            const wasStarted = existingExecution.started;
            existingExecution.end(undefined);
            // Note: end() callback automatically removes it from the map

            // Create a fresh execution wrapper
            const cellExecution = CellExecutionCreator.create(cell, controller, clearOutputOnStartWithTime);

            // If the old execution was started, start the new one immediately
            // This handles the case where we're switching controllers mid-execution
            if (wasStarted) {
                cellExecution.start(new Date().getTime());
            }

            return cellExecution;
        }

        // No existing execution, create a fresh one
        return CellExecutionCreator.create(cell, controller, clearOutputOnStartWithTime);
    }
    static get(cell: NotebookCell) {
        return CellExecutionCreator._map.get(cell);
    }

    private static create(cell: NotebookCell, controller: IKernelController, clearOutputOnStartWithTime = false) {
        const result = new NotebookCellExecutionWrapper(
            controller.createNotebookCellExecution(cell),
            controller.id,
            () => {
                CellExecutionCreator._map.delete(cell);
            },
            clearOutputOnStartWithTime
        );
        CellExecutionCreator._map.set(cell, result);
        return result;
    }
}
