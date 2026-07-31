/**
 * Error whose message was already written to the cell output by {@link CellExecution}.
 * Callers such as `VSCodeNotebookController` must not append the same message again.
 */
export class CellExecutionOutputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CellExecutionOutputError';
    }
}
