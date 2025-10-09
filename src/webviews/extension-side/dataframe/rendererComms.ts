import { injectable } from 'inversify';
import {
    env,
    NotebookEdit,
    NotebookEditor,
    NotebookRendererMessaging,
    notebooks,
    workspace,
    WorkspaceEdit
} from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { logger } from '../../../platform/logging';

type SelectPageSizeCommand = {
    command: 'selectPageSize';
    cellIndex: number;
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
export class DataframeRendererComms implements IExtensionSyncActivationService {
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
        logger.info('DataframeRendererComms received message', message);

        if (!message || typeof message !== 'object') {
            return;
        }

        switch (message.command) {
            case 'selectPageSize':
                this.handleSelectPageSize(editor, message);
                break;
            case 'goToPage':
                this.handleGoToPage(editor, message);
                break;
            case 'copyTableData':
                this.handleCopyTableData(message);
                break;
            case 'exportDataframe':
                this.handleExportDataframe(editor, message);
                break;
        }
    }

    private async handleSelectPageSize(editor: NotebookEditor, message: SelectPageSizeCommand) {
        const cell = editor.notebook.cellAt(message.cellIndex);
        logger.info(
            `[DataframeRenderer] selectPageSize called for cell ${
                message.cellIndex
            } (${cell?.document.uri.toString()}), size=${message.size}`
        );

        // Store page size in cell metadata
        if (cell) {
            const edit = new WorkspaceEdit();
            const notebookEdit = NotebookEdit.updateCellMetadata(message.cellIndex, {
                ...cell.metadata,
                dataframePageSize: message.size
            });
            edit.set(editor.notebook.uri, [notebookEdit]);
            await workspace.applyEdit(edit);
        }
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
