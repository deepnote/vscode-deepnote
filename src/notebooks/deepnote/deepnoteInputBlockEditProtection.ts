import {
    Disposable,
    NotebookCell,
    NotebookDocumentChangeEvent,
    Position,
    Range,
    workspace,
    WorkspaceEdit
} from 'vscode';
import { formatInputBlockCellContent } from './inputBlockContentFormatter';

/**
 * Protects readonly input blocks from being edited by reverting changes.
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

        // Process cell changes (content edits)
        for (const cellChange of e.cellChanges) {
            const cell = cellChange.cell;

            // Check if this is a readonly input block
            const blockType = cell.metadata?.__deepnotePocket?.type || cell.metadata?.type;
            if (!blockType || !this.readonlyInputTypes.has(blockType)) {
                continue;
            }

            // Check if the document (content) changed
            if (cellChange.document) {
                // Revert the change by restoring content from metadata
                await this.revertCellContent(cell);
            }
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

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
