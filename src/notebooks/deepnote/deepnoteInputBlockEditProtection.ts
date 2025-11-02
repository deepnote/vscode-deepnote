import { injectable, inject } from 'inversify';
import {
    Disposable,
    NotebookCell,
    NotebookCellData,
    NotebookDocumentChangeEvent,
    NotebookEdit,
    NotebookRange,
    Position,
    Range,
    Uri,
    workspace,
    WorkspaceEdit
} from 'vscode';
import { ILogger } from '../../platform/logging/types';
import { formatInputBlockCellContent, getInputBlockLanguage } from './inputBlockContentFormatter';

/**
 * Protects readonly input blocks from being edited by reverting changes.
 * Also protects the language ID of all input blocks.
 * This is needed because VSCode doesn't support the `editable: false` metadata property.
 */
@injectable()
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

    constructor(@inject(ILogger) private readonly logger: ILogger) {
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
                const expectedLanguage = getInputBlockLanguage(blockType);
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
            const lastLine = Math.max(0, cell.document.lineCount - 1);
            const fullRange = new Range(
                new Position(0, 0),
                new Position(lastLine, cell.document.lineAt(lastLine).text.length)
            );
            edit.replace(cell.document.uri, fullRange, correctContent);
            const success = await workspace.applyEdit(edit);
            if (!success) {
                this.logger.error(
                    `Failed to revert cell content for input block type '${blockType}' at cell index ${
                        cell.index
                    } in notebook ${cell.notebook.uri.toString()}`
                );
            }
        }
    }

    private async protectCellLanguages(cellsToFix: Array<{ cell: NotebookCell; blockType: string }>): Promise<void> {
        if (cellsToFix.length === 0) {
            return;
        }

        // Group cells by notebook to apply edits efficiently
        const editsByNotebook = new Map<string, { uri: Uri; edits: NotebookEdit[] }>();

        for (const { cell, blockType } of cellsToFix) {
            const expectedLanguage = getInputBlockLanguage(blockType);

            if (!expectedLanguage) {
                continue;
            }

            const notebookUriStr = cell.notebook.uri.toString();
            if (!editsByNotebook.has(notebookUriStr)) {
                editsByNotebook.set(notebookUriStr, { uri: cell.notebook.uri, edits: [] });
            }

            // Add the cell replacement edit
            const cellData = new NotebookCellData(cell.kind, cell.document.getText(), expectedLanguage);
            cellData.metadata = cell.metadata;

            editsByNotebook
                .get(notebookUriStr)!
                .edits.push(NotebookEdit.replaceCells(new NotebookRange(cell.index, cell.index + 1), [cellData]));
        }

        // Apply all edits in a single workspace edit to minimize flickering
        const workspaceEdit = new WorkspaceEdit();
        for (const { uri, edits } of editsByNotebook.values()) {
            workspaceEdit.set(uri, edits);
        }

        const success = await workspace.applyEdit(workspaceEdit);
        if (!success) {
            const cellInfo = cellsToFix
                .map(({ cell, blockType }) => `cell ${cell.index} (type: ${blockType})`)
                .join(', ');
            this.logger.error(
                `Failed to protect cell languages for ${cellsToFix.length} cell(s): ${cellInfo} in notebook(s)`
            );
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
