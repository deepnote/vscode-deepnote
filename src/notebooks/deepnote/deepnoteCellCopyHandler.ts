import { injectable, inject } from 'inversify';
import {
    workspace,
    NotebookDocumentChangeEvent,
    NotebookEdit,
    WorkspaceEdit,
    commands,
    window,
    NotebookCellData,
    NotebookRange
} from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { generateBlockId, generateSortingKey } from './dataConversionUtils';

/**
 * Handles cell copy operations in Deepnote notebooks to ensure metadata is preserved.
 *
 * VSCode's built-in copy commands don't preserve custom cell metadata, so this handler
 * provides a custom copy command that properly preserves all metadata fields including
 * sql_integration_id for SQL blocks.
 */
@injectable()
export class DeepnoteCellCopyHandler implements IExtensionSyncActivationService {
    private processingChanges = false;

    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {}

    public activate(): void {
        // Register custom copy command that preserves metadata
        this.disposables.push(commands.registerCommand('deepnote.copyCellDown', () => this.copyCellDown()));

        // Listen for notebook document changes to detect when cells are added without metadata
        this.disposables.push(workspace.onDidChangeNotebookDocument((e) => this.onDidChangeNotebookDocument(e)));
    }

    private async copyCellDown(): Promise<void> {
        const editor = window.activeNotebookEditor;

        if (!editor || !editor.notebook.uri.path.endsWith('.deepnote')) {
            // Fall back to default copy command for non-Deepnote notebooks
            await commands.executeCommand('notebook.cell.copyDown');
            return;
        }

        const selection = editor.selection;
        if (!selection) {
            return;
        }

        const cellToCopy = editor.notebook.cellAt(selection.start);
        const insertIndex = selection.start + 1;

        // Create a new cell with the same content and metadata
        const newCell = new NotebookCellData(
            cellToCopy.kind,
            cellToCopy.document.getText(),
            cellToCopy.document.languageId
        );

        // Copy all metadata, but generate new ID and sortingKey
        if (cellToCopy.metadata) {
            const copiedMetadata = { ...cellToCopy.metadata };

            // Generate new unique ID
            copiedMetadata.id = generateBlockId();

            // Update sortingKey in pocket if it exists
            if (copiedMetadata.__deepnotePocket) {
                copiedMetadata.__deepnotePocket = {
                    ...copiedMetadata.__deepnotePocket,
                    sortingKey: generateSortingKey(insertIndex)
                };
            } else if (copiedMetadata.sortingKey) {
                copiedMetadata.sortingKey = generateSortingKey(insertIndex);
            }

            newCell.metadata = copiedMetadata;

            logger.info(
                `DeepnoteCellCopyHandler: Copying cell with metadata preserved: ${JSON.stringify(
                    copiedMetadata,
                    null,
                    2
                )}`
            );
        }

        // Copy outputs if present
        if (cellToCopy.outputs.length > 0) {
            newCell.outputs = cellToCopy.outputs.map((output) => output);
        }

        // Insert the new cell
        const edit = new WorkspaceEdit();
        edit.set(editor.notebook.uri, [NotebookEdit.insertCells(insertIndex, [newCell])]);

        const success = await workspace.applyEdit(edit);

        if (success) {
            // Move selection to the new cell
            editor.selection = new NotebookRange(insertIndex, insertIndex + 1);
            logger.info(`DeepnoteCellCopyHandler: Successfully copied cell to index ${insertIndex}`);
        } else {
            logger.warn('DeepnoteCellCopyHandler: Failed to copy cell');
        }
    }

    private async onDidChangeNotebookDocument(e: NotebookDocumentChangeEvent): Promise<void> {
        // Only process Deepnote notebooks
        if (!e.notebook.uri.path.endsWith('.deepnote')) {
            return;
        }

        // Avoid recursive processing
        if (this.processingChanges) {
            return;
        }

        // Check for cell additions (which includes copies)
        for (const change of e.contentChanges) {
            if (change.addedCells.length === 0) {
                continue;
            }

            // When cells are copied, VSCode should preserve metadata automatically.
            // However, we need to ensure that:
            // 1. Each cell has a unique ID
            // 2. The sortingKey is updated based on the new position
            // 3. All other metadata (including sql_integration_id) is preserved

            const cellsNeedingMetadataFix: Array<{ index: number; metadata: Record<string, unknown> }> = [];

            for (const cell of change.addedCells) {
                const metadata = cell.metadata || {};

                // Log the metadata to see what's actually being copied
                logger.info(`DeepnoteCellCopyHandler: Cell added with metadata: ${JSON.stringify(metadata, null, 2)}`);

                // Only process Deepnote cells (cells with type or pocket metadata)
                if (!metadata.type && !metadata.__deepnotePocket) {
                    continue;
                }

                const cellIndex = e.notebook.getCells().indexOf(cell);

                if (cellIndex === -1) {
                    continue;
                }

                // Check if this cell needs metadata updates
                // We update the ID and sortingKey for all added Deepnote cells to ensure uniqueness
                const updatedMetadata = { ...metadata };

                // Generate new ID for the cell (important for copied cells)
                updatedMetadata.id = generateBlockId();

                // Update sortingKey based on the new position
                if (updatedMetadata.__deepnotePocket) {
                    updatedMetadata.__deepnotePocket = {
                        ...updatedMetadata.__deepnotePocket,
                        sortingKey: generateSortingKey(cellIndex)
                    };
                } else if (updatedMetadata.sortingKey) {
                    updatedMetadata.sortingKey = generateSortingKey(cellIndex);
                }

                // All other metadata (including sql_integration_id) is preserved from the original metadata
                cellsNeedingMetadataFix.push({
                    index: cellIndex,
                    metadata: updatedMetadata
                });

                logger.info(
                    `DeepnoteCellCopyHandler: Updated metadata for ${
                        metadata.type
                    } cell at index ${cellIndex}: ${JSON.stringify(updatedMetadata, null, 2)}`
                );
            }

            // Apply metadata fixes if needed
            if (cellsNeedingMetadataFix.length > 0) {
                await this.applyMetadataFixes(e.notebook.uri, cellsNeedingMetadataFix);
            }
        }
    }

    private async applyMetadataFixes(
        notebookUri: import('vscode').Uri,
        fixes: Array<{ index: number; metadata: Record<string, unknown> }>
    ): Promise<void> {
        try {
            this.processingChanges = true;

            const edit = new WorkspaceEdit();

            // Create all the edits at once instead of calling set() multiple times
            const edits = fixes.map((fix) => NotebookEdit.updateCellMetadata(fix.index, fix.metadata));
            edit.set(notebookUri, edits);

            const success = await workspace.applyEdit(edit);

            if (success) {
                logger.info(`DeepnoteCellCopyHandler: Successfully updated metadata for ${fixes.length} cell(s)`);
            } else {
                logger.warn(`DeepnoteCellCopyHandler: Failed to apply metadata fixes for ${fixes.length} cell(s)`);
            }
        } catch (error) {
            logger.error('DeepnoteCellCopyHandler: Error applying metadata fixes', error);
        } finally {
            this.processingChanges = false;
        }
    }
}
