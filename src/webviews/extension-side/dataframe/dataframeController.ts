import { injectable } from 'inversify';
import {
    commands,
    env,
    NotebookEdit,
    NotebookEditor,
    NotebookRendererMessaging,
    notebooks,
    window,
    workspace,
    WorkspaceEdit
} from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { logger } from '../../../platform/logging';

type SelectPageSizeCommand = {
    cellId?: string;
    cellIndex?: number;
    command: 'selectPageSize';
    size: number;
};

type GoToPageCommand = {
    command: 'goToPage';
    cellIndex: number;
    page: number;
};

type CopyTableDataCommand = {
    command: 'copyTableData';
    data: string;
};

type ExportDataframeCommand = {
    command: 'exportDataframe';
    cellIndex: number;
};

type DataframeCommand = SelectPageSizeCommand | GoToPageCommand | CopyTableDataCommand | ExportDataframeCommand;

@injectable()
export class DataframeController implements IExtensionSyncActivationService {
    private readonly disposables: IDisposable[] = [];

    public dispose() {
        dispose(this.disposables);
    }

    activate() {
        const comms = notebooks.createRendererMessaging('deepnote-dataframe-renderer');
        comms.onDidReceiveMessage(this.onDidReceiveMessage.bind(this, comms), this, this.disposables);
    }

    private onDidReceiveMessage(
        _comms: NotebookRendererMessaging,
        { editor, message }: { editor: NotebookEditor; message: DataframeCommand }
    ) {
        logger.info('DataframeController received message', message);

        if (!message || typeof message !== 'object') {
            return;
        }

        switch (message.command) {
            case 'selectPageSize':
                void this.handleSelectPageSize(editor, message);
                break;
            case 'goToPage':
                void this.handleGoToPage(editor, message);
                break;
            case 'copyTableData':
                void this.handleCopyTableData(message);
                break;
            case 'exportDataframe':
                void this.handleExportDataframe(editor, message);
                break;
        }
    }

    private async handleSelectPageSize(editor: NotebookEditor, message: SelectPageSizeCommand) {
        let cell;
        let cellIndex: number;

        // Try to find cell by cellId first (more reliable)
        if (message.cellId) {
            const cells = editor.notebook.getCells();
            const foundCell = cells.find((c) => c.metadata.id === message.cellId);

            if (foundCell) {
                cell = foundCell;
                cellIndex = foundCell.index;
                logger.info(`[DataframeController] Found cell by cellId ${message.cellId} at index ${cellIndex}`);
            } else {
                const errorMessage = `Unable to update page size: Could not find the cell with ID ${message.cellId}. The cell may have been deleted.`;
                logger.error(`[DataframeController] ${errorMessage}`);
                await window.showErrorMessage(errorMessage);
                throw new Error(errorMessage);
            }
        } else if (message.cellIndex !== undefined) {
            // Fall back to cellIndex if cellId is not available
            try {
                cell = editor.notebook.cellAt(message.cellIndex);
                cellIndex = message.cellIndex;
                logger.info(`[DataframeController] Using cellIndex ${cellIndex} (cellId not available)`);
            } catch (error) {
                const errorMessage = `Unable to update page size: Cell at index ${message.cellIndex} not found. The notebook structure may have changed.`;
                logger.error(`[DataframeController] ${errorMessage}`, error);
                await window.showErrorMessage(errorMessage);
                throw new Error(errorMessage);
            }
        } else {
            const errorMessage =
                'Unable to update page size: No cell identifier provided. ' +
                'Please re-run the cell to update the output metadata.';
            logger.error(`[DataframeController] ${errorMessage}`);
            await window.showErrorMessage(errorMessage);
            throw new Error(errorMessage);
        }

        // Update page size in table state within cell metadata
        const existingTableState = cell.metadata.deepnote_table_state || {};
        const updatedTableState = {
            ...existingTableState,
            pageSize: message.size
        };

        const edit = new WorkspaceEdit();
        const notebookEdit = NotebookEdit.updateCellMetadata(cellIndex, {
            ...cell.metadata,
            deepnote_table_state: updatedTableState
        });

        edit.set(editor.notebook.uri, [notebookEdit]);

        await workspace.applyEdit(edit);

        // Re-execute the cell to apply the new page size
        logger.info(`[DataframeRenderer] Re-executing cell ${cellIndex} with new page size`);
        await commands.executeCommand('notebook.cell.execute', {
            ranges: [{ start: cellIndex, end: cellIndex + 1 }],
            document: editor.notebook.uri
        });
    }

    private handleGoToPage(editor: NotebookEditor, message: GoToPageCommand) {
        const cell = editor.notebook.cellAt(message.cellIndex);
        logger.info(
            `[DataframeRenderer] goToPage called for cell ${
                message.cellIndex
            } (${cell?.document.uri.toString()}), page=${message.page}`
        );
        // Could store current page in cell metadata if needed
    }

    private async handleCopyTableData(message: CopyTableDataCommand) {
        logger.info(`[DataframeRenderer] copyTableData called, data length=${message.data.length} characters`);
        await env.clipboard.writeText(message.data);
    }

    private handleExportDataframe(editor: NotebookEditor, message: ExportDataframeCommand) {
        const cell = editor.notebook.cellAt(message.cellIndex);
        logger.info(
            `[DataframeRenderer] exportDataframe called for cell ${
                message.cellIndex
            } (${cell?.document.uri.toString()})`
        );
        // TODO: Implement dataframe export functionality
    }
}
