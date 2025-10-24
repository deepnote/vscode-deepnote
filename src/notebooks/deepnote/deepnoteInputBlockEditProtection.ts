import {
    Disposable,
    NotebookCell,
    NotebookDocumentChangeEvent,
    NotebookEdit,
    NotebookRange,
    Position,
    Range,
    Uri,
    workspace,
    WorkspaceEdit
} from 'vscode';
import { formatInputBlockCellContent } from './inputBlockContentFormatter';

/**
 * Protects readonly input blocks from being edited by reverting changes.
 * Also protects the language ID of all input blocks.
 * This is needed because VSCode doesn't support the `editable: false` metadata property.
 */
export class DeepnoteInputBlockEditProtection implements Disposable {
    private readonly disposables: Disposable[] = [];

    // Input types that should be readonly (controlled via status bar)
    private readonly readonlyInputTypes = new Set([
        'input-select',
        'input-checkbox',
        'input-date',
        'input-date-range',
        'button'
    ]);

    // All input block types (for language protection)
    private readonly allInputTypes = new Set([
        'input-text',
        'input-textarea',
        'input-select',
        'input-slider',
        'input-checkbox',
        'input-date',
        'input-date-range',
        'input-file',
        'button'
    ]);

    // Map of block types to their expected language IDs
    private readonly expectedLanguages = new Map<string, string>([
        ['input-text', 'plaintext'],
        ['input-textarea', 'plaintext'],
        ['input-select', 'python'],
        ['input-slider', 'python'],
        ['input-checkbox', 'python'],
        ['input-date', 'python'],
        ['input-date-range', 'python'],
        ['input-file', 'python'],
        ['button', 'python']
    ]);

    constructor() {
        // Listen for notebook document changes
        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e) => {
                void this.handleNotebookChange(e);
            })
        );
    }

    private async handleNotebookChange(e: NotebookDocumentChangeEvent): Promise<void> {
        // Check if this is a Deepnote notebook
        if (e.notebook.notebookType !== 'deepnote') {
            return;
        }

        // Collect all cells that need language fixes in a single batch
        const cellsToFix: Array<{ cell: NotebookCell; blockType: string }> = [];

        // Process content changes (cell edits)
        for (const cellChange of e.cellChanges) {
            const cell = cellChange.cell;
            const blockType = cell.metadata?.__deepnotePocket?.type || cell.metadata?.type;

            if (!blockType || !this.allInputTypes.has(blockType)) {
                continue;
            }

            // Check if the document (content) changed for readonly blocks
            if (cellChange.document && this.readonlyInputTypes.has(blockType)) {
                // Revert the change by restoring content from metadata
                await this.revertCellContent(cell);
            }
        }

        // Check all cells in the notebook for language changes
        // We need to check all cells because language changes don't reliably appear in cellChanges or contentChanges
        for (const cell of e.notebook.getCells()) {
            const blockType = cell.metadata?.__deepnotePocket?.type || cell.metadata?.type;

            if (blockType && this.allInputTypes.has(blockType)) {
                const expectedLanguage = this.expectedLanguages.get(blockType);
                // Only add to fix list if language is actually wrong
                if (expectedLanguage && cell.document.languageId !== expectedLanguage) {
                    cellsToFix.push({ cell, blockType });
                }
            }
        }

        // Apply all language fixes in a single batch to minimize flickering
        if (cellsToFix.length > 0) {
            await this.protectCellLanguages(cellsToFix);
        }
    }

    private async revertCellContent(cell: NotebookCell): Promise<void> {
        const blockType = cell.metadata?.__deepnotePocket?.type || cell.metadata?.type;
        const metadata = cell.metadata;

        // Use shared formatter to get correct content
        const correctContent = formatInputBlockCellContent(blockType, metadata);

        // Only revert if content actually changed
        if (cell.document.getText() !== correctContent) {
            const edit = new WorkspaceEdit();
            const fullRange = new Range(
                new Position(0, 0),
                new Position(cell.document.lineCount - 1, cell.document.lineAt(cell.document.lineCount - 1).text.length)
            );
            edit.replace(cell.document.uri, fullRange, correctContent);
            await workspace.applyEdit(edit);
        }
    }

    private async protectCellLanguages(cellsToFix: Array<{ cell: NotebookCell; blockType: string }>): Promise<void> {
        if (cellsToFix.length === 0) {
            return;
        }

        // Group cells by notebook to apply edits efficiently
        const editsByNotebook = new Map<string, { uri: Uri; edits: NotebookEdit[] }>();

        for (const { cell, blockType } of cellsToFix) {
            const expectedLanguage = this.expectedLanguages.get(blockType);

            if (!expectedLanguage) {
                continue;
            }

            const notebookUriStr = cell.notebook.uri.toString();
            if (!editsByNotebook.has(notebookUriStr)) {
                editsByNotebook.set(notebookUriStr, { uri: cell.notebook.uri, edits: [] });
            }

            // Add the cell replacement edit
            editsByNotebook.get(notebookUriStr)!.edits.push(
                NotebookEdit.replaceCells(new NotebookRange(cell.index, cell.index + 1), [
                    {
                        kind: cell.kind,
                        languageId: expectedLanguage,
                        value: cell.document.getText(),
                        metadata: cell.metadata
                    }
                ])
            );
        }

        // Apply all edits in a single workspace edit to minimize flickering
        const workspaceEdit = new WorkspaceEdit();
        for (const { uri, edits } of editsByNotebook.values()) {
            workspaceEdit.set(uri, edits);
        }

        await workspace.applyEdit(workspaceEdit);
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
