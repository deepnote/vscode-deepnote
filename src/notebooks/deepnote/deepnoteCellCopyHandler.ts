import { injectable, inject } from 'inversify';
import {
    workspace,
    NotebookDocumentChangeEvent,
    NotebookEdit,
    WorkspaceEdit,
    commands,
    window,
    NotebookCellData,
    NotebookRange,
    env
} from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { generateBlockId, generateSortingKey } from './dataConversionUtils';

/**
 * Marker prefix for clipboard data to identify Deepnote cell metadata
 */
const CLIPBOARD_MARKER = '___DEEPNOTE_CELL_METADATA___';

/**
 * Interface for cell metadata stored in clipboard
 */
interface ClipboardCellMetadata {
    metadata: Record<string, unknown>;
    kind: number;
    languageId: string;
    value: string;
}

/**
 * Handles cell copy operations in Deepnote notebooks to ensure metadata is preserved.
 *
 * VSCode's built-in copy commands don't preserve custom cell metadata, so this handler
 * intercepts copy/cut/paste commands and stores metadata in the clipboard as JSON.
 * This allows metadata to be preserved across copy/paste and cut/paste operations.
 */
@injectable()
export class DeepnoteCellCopyHandler implements IExtensionSyncActivationService {
    private processingChanges = false;

    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {}

    public activate(): void {
        // Register custom copy commands that preserve metadata
        this.disposables.push(commands.registerCommand('deepnote.copyCellDown', () => this.copyCellDown()));
        this.disposables.push(commands.registerCommand('deepnote.copyCellUp', () => this.copyCellUp()));

        // Override built-in notebook copy/cut commands to preserve metadata for Deepnote notebooks
        this.disposables.push(commands.registerCommand('notebook.cell.copyDown', () => this.copyCellDownInterceptor()));
        this.disposables.push(commands.registerCommand('notebook.cell.copyUp', () => this.copyCellUpInterceptor()));
        this.disposables.push(commands.registerCommand('notebook.cell.copy', () => this.copyCellInterceptor()));
        this.disposables.push(commands.registerCommand('notebook.cell.cut', () => this.cutCellInterceptor()));
        this.disposables.push(commands.registerCommand('notebook.cell.paste', () => this.pasteCellInterceptor()));

        // Listen for notebook document changes to detect when cells are added without metadata
        this.disposables.push(workspace.onDidChangeNotebookDocument((e) => this.onDidChangeNotebookDocument(e)));
    }

    /**
     * Interceptor for the built-in notebook.cell.copyDown command.
     * Routes to our custom implementation for Deepnote notebooks.
     */
    private async copyCellDownInterceptor(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (editor && editor.notebook && editor.notebook.notebookType === 'deepnote') {
            await this.copyCellDown();
        } else {
            logger.warn('notebook.cell.copyDown intercepted for non-Deepnote notebook - using fallback');
        }
    }

    /**
     * Interceptor for the built-in notebook.cell.copyUp command.
     * Routes to our custom implementation for Deepnote notebooks.
     */
    private async copyCellUpInterceptor(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (editor && editor.notebook && editor.notebook.notebookType === 'deepnote') {
            await this.copyCellUp();
        } else {
            logger.warn('notebook.cell.copyUp intercepted for non-Deepnote notebook - using fallback');
        }
    }

    /**
     * Interceptor for the built-in notebook.cell.copy command.
     * Stores cell metadata in clipboard for Deepnote notebooks.
     */
    private async copyCellInterceptor(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (editor && editor.notebook && editor.notebook.notebookType === 'deepnote') {
            await this.copyCellToClipboard(false);
        } else {
            logger.warn('notebook.cell.copy intercepted for non-Deepnote notebook - using fallback');
        }
    }

    /**
     * Interceptor for the built-in notebook.cell.cut command.
     * Stores cell metadata in clipboard for Deepnote notebooks.
     */
    private async cutCellInterceptor(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (editor && editor.notebook && editor.notebook.notebookType === 'deepnote') {
            await this.copyCellToClipboard(true);
        } else {
            logger.warn('notebook.cell.cut intercepted for non-Deepnote notebook - using fallback');
        }
    }

    /**
     * Interceptor for the built-in notebook.cell.paste command.
     * Restores cell metadata from clipboard for Deepnote notebooks.
     */
    private async pasteCellInterceptor(): Promise<void> {
        const editor = window.activeNotebookEditor;
        if (editor && editor.notebook && editor.notebook.notebookType === 'deepnote') {
            await this.pasteCellFromClipboard();
        } else {
            logger.warn('notebook.cell.paste intercepted for non-Deepnote notebook - using fallback');
        }
    }

    private async copyCellDown(): Promise<void> {
        await this.copyCellAtOffset(1);
    }

    private async copyCellUp(): Promise<void> {
        await this.copyCellAtOffset(-1);
    }

    /**
     * Copy a cell at a specific offset from the current cell.
     * @param offset -1 for copy up, 1 for copy down
     */
    private async copyCellAtOffset(offset: number): Promise<void> {
        const editor = window.activeNotebookEditor;

        if (!editor || !editor.notebook || editor.notebook.notebookType !== 'deepnote') {
            logger.warn(`copyCellAtOffset called for non-Deepnote notebook`);
            return;
        }

        const selection = editor.selection;
        if (!selection) {
            return;
        }

        const cellToCopy = editor.notebook.cellAt(selection.start);
        const insertIndex = offset > 0 ? selection.start + 1 : selection.start;

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
        if (e.notebook.notebookType !== 'deepnote') {
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

    /**
     * Copy or cut a cell to the clipboard with metadata preserved.
     * @param isCut Whether this is a cut operation (will delete the cell after copying)
     */
    private async copyCellToClipboard(isCut: boolean): Promise<void> {
        const editor = window.activeNotebookEditor;

        if (!editor || !editor.notebook || editor.notebook.notebookType !== 'deepnote') {
            logger.warn(`copyCellToClipboard called for non-Deepnote notebook`);
            return;
        }

        const selection = editor.selection;
        if (!selection) {
            return;
        }

        const cellToCopy = editor.notebook.cellAt(selection.start);

        // Create clipboard data with all cell information
        const clipboardData: ClipboardCellMetadata = {
            metadata: cellToCopy.metadata || {},
            kind: cellToCopy.kind,
            languageId: cellToCopy.document.languageId,
            value: cellToCopy.document.getText()
        };

        // Store in clipboard as JSON with marker
        const clipboardText = `${CLIPBOARD_MARKER}${JSON.stringify(clipboardData)}`;
        await env.clipboard.writeText(clipboardText);

        logger.info(
            `DeepnoteCellCopyHandler: ${isCut ? 'Cut' : 'Copied'} cell to clipboard with metadata: ${JSON.stringify(
                clipboardData.metadata,
                null,
                2
            )}`
        );

        // If this is a cut operation, delete the cell
        if (isCut) {
            const edit = new WorkspaceEdit();
            edit.set(editor.notebook.uri, [
                NotebookEdit.deleteCells(new NotebookRange(selection.start, selection.start + 1))
            ]);
            await workspace.applyEdit(edit);
            logger.info(`DeepnoteCellCopyHandler: Deleted cell after cut operation`);
        }
    }

    /**
     * Paste a cell from the clipboard, restoring metadata if available.
     */
    private async pasteCellFromClipboard(): Promise<void> {
        const editor = window.activeNotebookEditor;

        if (!editor || !editor.notebook || editor.notebook.notebookType !== 'deepnote') {
            logger.warn(`pasteCellFromClipboard called for non-Deepnote notebook`);
            return;
        }

        const selection = editor.selection;
        if (!selection) {
            return;
        }

        // Read from clipboard
        const clipboardText = await env.clipboard.readText();

        // Check if clipboard contains our metadata marker
        if (!clipboardText.startsWith(CLIPBOARD_MARKER)) {
            logger.info('DeepnoteCellCopyHandler: Clipboard does not contain Deepnote cell metadata, skipping');
            return;
        }

        try {
            // Parse clipboard data
            const jsonText = clipboardText.substring(CLIPBOARD_MARKER.length);
            const clipboardData: ClipboardCellMetadata = JSON.parse(jsonText);

            // Create new cell with preserved metadata
            const newCell = new NotebookCellData(clipboardData.kind, clipboardData.value, clipboardData.languageId);

            // Copy metadata but generate new ID and sortingKey
            const copiedMetadata = { ...clipboardData.metadata };

            // Generate new unique ID
            copiedMetadata.id = generateBlockId();

            // Update sortingKey in pocket if it exists
            const insertIndex = selection.start;
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
                `DeepnoteCellCopyHandler: Pasting cell with metadata preserved: ${JSON.stringify(
                    copiedMetadata,
                    null,
                    2
                )}`
            );

            // Insert the new cell
            const edit = new WorkspaceEdit();
            edit.set(editor.notebook.uri, [NotebookEdit.insertCells(insertIndex, [newCell])]);

            const success = await workspace.applyEdit(edit);

            if (success) {
                // Move selection to the new cell
                editor.selection = new NotebookRange(insertIndex, insertIndex + 1);
                logger.info(`DeepnoteCellCopyHandler: Successfully pasted cell at index ${insertIndex}`);
            } else {
                logger.warn('DeepnoteCellCopyHandler: Failed to paste cell');
            }
        } catch (error) {
            logger.error('DeepnoteCellCopyHandler: Error parsing clipboard data', error);
        }
    }
}
