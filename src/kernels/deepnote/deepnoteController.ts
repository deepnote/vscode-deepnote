import {
    CancellationToken,
    NotebookCell,
    NotebookCellExecution,
    NotebookCellOutput,
    NotebookCellOutputItem
} from 'vscode';

import { KernelController } from '../kernelController';

/**
 * Wrapper around NotebookCellExecution that prepends initialization code.
 * This is implemented by delegating all calls to the underlying execution object.
 *
 * Note: This wrapper currently just delegates to the underlying execution.
 * The actual code interception will be implemented at the execution layer.
 */
class DeepnoteNotebookCellExecution implements NotebookCellExecution {
    constructor(
        private readonly execution: NotebookCellExecution,
        public readonly cell: NotebookCell
    ) {
        // Prepend code will be: print("Hello world")
        // This will be implemented at the CellExecution layer
    }

    get executionOrder(): number | undefined {
        return this.execution.executionOrder;
    }

    set executionOrder(value: number | undefined) {
        this.execution.executionOrder = value;
    }

    get token(): CancellationToken {
        return this.execution.token;
    }

    public start(startTime?: number): void {
        this.execution.start(startTime);
    }

    public end(success: boolean | undefined, endTime?: number): void {
        this.execution.end(success, endTime);
    }

    public clearOutput(cell?: NotebookCell): Thenable<void> {
        return this.execution.clearOutput(cell);
    }

    public replaceOutput(out: NotebookCellOutput | readonly NotebookCellOutput[], cell?: NotebookCell): Thenable<void> {
        return this.execution.replaceOutput(out, cell);
    }

    public appendOutput(out: NotebookCellOutput | readonly NotebookCellOutput[], cell?: NotebookCell): Thenable<void> {
        return this.execution.appendOutput(out, cell);
    }

    public replaceOutputItems(
        items: NotebookCellOutputItem | readonly NotebookCellOutputItem[],
        output: NotebookCellOutput
    ): Thenable<void> {
        return this.execution.replaceOutputItems(items, output);
    }

    public appendOutputItems(
        items: NotebookCellOutputItem | readonly NotebookCellOutputItem[],
        output: NotebookCellOutput
    ): Thenable<void> {
        return this.execution.appendOutputItems(items, output);
    }
}

/**
 * DeepnoteController extends KernelController to intercept cell execution
 * and prepend initialization code to each cell execution.
 */
export class DeepnoteController extends KernelController {
    public override createNotebookCellExecution(cell: NotebookCell): NotebookCellExecution {
        const execution = super.createNotebookCellExecution(cell);

        return new DeepnoteNotebookCellExecution(execution, cell);
    }
}
