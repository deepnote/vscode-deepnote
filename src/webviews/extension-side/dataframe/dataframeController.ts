import { injectable } from 'inversify';
import {
    commands,
    env,
    l10n,
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
    cellId?: string;
    cellIndex?: number;
    command: 'goToPage';
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

    private async onDidReceiveMessage(
        _comms: NotebookRendererMessaging,
        { editor, message }: { editor: NotebookEditor; message: DataframeCommand }
    ) {
        logger.info('DataframeController received message', message);

        if (!message || typeof message !== 'object') {
            return;
        }

        if (message.command === 'selectPageSize') {
            return this.handleSelectPageSize(editor, message);
        }

        if (message.command === 'goToPage') {
            return this.handleGoToPage(editor, message);
        }

        if (message.command === 'copyTableData') {
            return this.handleCopyTableData(message);
        }

        if (message.command === 'exportDataframe') {
            return this.handleExportDataframe(editor, message);
        }

        logger.warn(`DataframeController received unknown command:`, message);
    }

    private async handleSelectPageSize(editor: NotebookEditor, message: SelectPageSizeCommand) {
        if (!message.cellId && message.cellIndex === undefined) {
            const errorMessage = l10n.t(
                'Unable to update page size: No cell identifier provided. Please re-run the cell to update the output metadata.'
            );

            logger.error(`[DataframeController] ${errorMessage}`);

            await window.showErrorMessage(errorMessage);

            throw new Error(errorMessage);
        }

        const cells = editor.notebook.getCells();
        const cell = cells.find((c) => c.metadata.id === message.cellId);

        if (!cell) {
            const errorMessage = l10n.t(
                'Unable to update page size: Could not find the cell with ID {0}. The cell may have been deleted.',
                message.cellId ?? ''
            );

            logger.error(`[DataframeController] ${errorMessage}`);

            await window.showErrorMessage(errorMessage);

            throw new Error(errorMessage);
        }

        const cellIndex = cell.index;

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

    private async handleGoToPage(editor: NotebookEditor, message: GoToPageCommand) {
        if (!message.cellId) {
            const errorMessage = l10n.t(
                'Unable to navigate to page: No cell identifier provided. Please re-run the cell to update the output metadata.'
            );

            logger.error(`[DataframeController] ${errorMessage}`);

            await window.showErrorMessage(errorMessage);

            throw new Error(errorMessage);
        }

        const cells = editor.notebook.getCells();
        const cell = cells.find((c) => c.metadata.id === message.cellId);

        if (!cell) {
            const errorMessage = l10n.t(
                'Unable to navigate to page: Could not find the cell with ID {0}. The cell may have been deleted.',
                message.cellId ?? ''
            );

            logger.error(`[DataframeController] ${errorMessage}`);

            await window.showErrorMessage(errorMessage);

            throw new Error(errorMessage);
        }

        // Update page index in table state within cell metadata
        const existingTableState = cell.metadata.deepnote_table_state || {};
        const updatedTableState = {
            ...existingTableState,
            pageIndex: message.page
        };

        const cellIndex = cell.index;

        const edit = new WorkspaceEdit();
        const notebookEdit = NotebookEdit.updateCellMetadata(cellIndex, {
            ...cell.metadata,
            deepnote_table_state: updatedTableState
        });

        edit.set(editor.notebook.uri, [notebookEdit]);

        await workspace.applyEdit(edit);

        // Re-execute the cell to apply the new page
        logger.info(`[DataframeController] Re-executing cell ${cellIndex} with new page index ${message.page}`);

        await commands.executeCommand('notebook.cell.execute', {
            ranges: [{ start: cellIndex, end: cellIndex + 1 }],
            document: editor.notebook.uri
        });
    }

    private async handleCopyTableData(message: CopyTableDataCommand) {
        logger.info(`[DataframeRenderer] copyTableData called, data length=${message.data.length} characters`);

        await env.clipboard.writeText(message.data);
    }

    private async handleExportDataframe(editor: NotebookEditor, message: ExportDataframeCommand) {
        const cell = editor.notebook.cellAt(message.cellIndex);

        logger.info(
            `[DataframeRenderer] exportDataframe called for cell ${
                message.cellIndex
            } (${cell?.document.uri.toString()})`
        );
        // TODO: Implement dataframe export functionality
    }
}
