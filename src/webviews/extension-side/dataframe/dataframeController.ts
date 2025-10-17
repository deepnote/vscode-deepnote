import { injectable } from 'inversify';
import {
    commands,
    env,
    l10n,
    NotebookEdit,
    type NotebookCellOutput,
    type NotebookEditor,
    type NotebookRendererMessaging,
    notebooks,
    Uri,
    window,
    workspace,
    WorkspaceEdit
} from 'vscode';

import type { IExtensionSyncActivationService } from '../../../platform/activation/types';
import type { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { logger } from '../../../platform/logging';

type SelectPageSizeCommand = {
    cellId?: string;
    command: 'selectPageSize';
    size: number;
};

type GoToPageCommand = {
    cellId?: string;
    command: 'goToPage';
    page: number;
};

type CopyTableCommand = {
    cellId?: string;
    command: 'copyTable';
};

type ExportTableCommand = {
    cellId?: string;
    command: 'exportTable';
};

interface DataFrameObject {
    column_count: number;
    columns: {
        dtype: string;
        name: string;
    }[];
    preview_row_count: number;
    row_count: number;
    rows: Record<string, unknown>[];
    type: string;
}

type DataframeCommand = SelectPageSizeCommand | GoToPageCommand | CopyTableCommand | ExportTableCommand;

@injectable()
export class DataframeController implements IExtensionSyncActivationService {
    private readonly disposables: IDisposable[] = [];

    public activate() {
        const comms = notebooks.createRendererMessaging('deepnote-dataframe-renderer');
        const messageDisposable = comms.onDidReceiveMessage(this.onDidReceiveMessage.bind(this, comms), this);
        this.disposables.push(messageDisposable);
    }

    public dispose() {
        dispose(this.disposables);
    }

    private escapeCsvField(value: unknown): string {
        // Handle null/undefined as empty string
        if (value === null || value === undefined) {
            return '';
        }

        // Convert to string
        const stringValue = String(value);

        // Check if field needs quoting (contains comma, quote, or newline)
        const needsQuoting =
            stringValue.includes(',') ||
            stringValue.includes('"') ||
            stringValue.includes('\n') ||
            stringValue.includes('\r');

        if (needsQuoting) {
            // Escape internal quotes by doubling them, then wrap in quotes
            return `"${stringValue.replace(/"/g, '""')}"`;
        }

        return stringValue;
    }

    private dataframeToCsv(dataframe: DataFrameObject): string {
        logger.debug('[DataframeController] Converting dataframe to CSV', {
            columnCount: dataframe?.column_count,
            rowCount: dataframe?.row_count
        });

        if (!dataframe || !dataframe.columns || !dataframe.rows) {
            return '';
        }

        const headers = dataframe.columns;
        const rows = dataframe.rows;
        const columnNames = headers
            .map((header: { name: string }) => header.name)
            .filter((name: string | undefined) => Boolean(name))
            .filter((name: string) => !name.trim().toLowerCase().startsWith('_deepnote')) as string[];

        // Escape and join header names
        const headerRow = columnNames.map((name) => this.escapeCsvField(name)).join(',');

        // Escape and join data rows
        const csvRows = rows.map((row: Record<string, unknown>) =>
            columnNames.map((col) => this.escapeCsvField(row[col])).join(',')
        );

        return [headerRow, ...csvRows].join('\n');
    }

    private async getDataframeFromDataframeOutput(
        outputs: readonly NotebookCellOutput[]
    ): Promise<DataFrameObject | undefined> {
        if (outputs.length === 0) {
            await this.showErrorToUser(l10n.t('No outputs found in the cell.'));
            return;
        }

        const items = outputs.flatMap((output) => output.items);
        const item = items.find(
            (i: { data: unknown; mime: string }) => i.mime === 'application/vnd.deepnote.dataframe.v3+json'
        );

        if (!item) {
            await this.showErrorToUser(
                l10n.t('No dataframe output found in the cell. Please ensure the cell has been executed.')
            );
            return;
        }

        const buffer = item.data as Uint8Array;
        const json = new TextDecoder('utf-8').decode(buffer);
        const dataframe = JSON.parse(json) as DataFrameObject;

        return dataframe;
    }

    private async handleCopyTable(editor: NotebookEditor, message: CopyTableCommand) {
        if (!message.cellId) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to copy table: No cell identifier provided. Please re-run the cell to update the output metadata.'
                )
            );
        }

        const cells = editor.notebook.getCells();
        const cell = cells.find((c) => c.metadata.id === message.cellId);

        if (!cell) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to copy table: Could not find the cell with ID {0}. The cell may have been deleted.',
                    message.cellId ?? ''
                )
            );
        }

        const dataframe = await this.getDataframeFromDataframeOutput(cell.outputs);

        if (!dataframe) {
            return;
        }

        const csv = this.dataframeToCsv(dataframe);

        if (!csv) {
            return this.showErrorToUser(l10n.t('The dataframe is empty or could not be converted to CSV format.'));
        }

        await env.clipboard.writeText(csv);

        await window.showInformationMessage(l10n.t('Text copied to clipboard!'));

        logger.info('[DataframeController] Dataframe copied to clipboard as CSV.');
    }

    private async handleExportTable(editor: NotebookEditor, message: ExportTableCommand) {
        if (!message.cellId) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to export table: No cell identifier provided. Please re-run the cell to update the output metadata.'
                )
            );
        }

        const cells = editor.notebook.getCells();
        const cell = cells.find((c) => c.metadata.id === message.cellId);

        if (!cell) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to export table: Could not find the cell with ID {0}. The cell may have been deleted.',
                    message.cellId ?? ''
                )
            );
        }

        const dataframe = await this.getDataframeFromDataframeOutput(cell.outputs);

        if (!dataframe) {
            return;
        }

        const csv = this.dataframeToCsv(dataframe);

        if (!csv) {
            return this.showErrorToUser(l10n.t('The dataframe is empty or could not be converted to CSV format.'));
        }

        const filename = `dataframe_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

        try {
            const uri = await window.showSaveDialog({
                defaultUri: Uri.file(filename),
                filters: {
                    'CSV files': ['csv'],
                    'All files': ['*']
                }
            });

            if (uri) {
                const encoder = new TextEncoder();

                await workspace.fs.writeFile(uri, encoder.encode(csv));

                await window.showInformationMessage(l10n.t('File saved to {0}', uri));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            await window.showErrorMessage(l10n.t('Failed to save file: {0}', message));
        }
    }

    private async handleGoToPage(editor: NotebookEditor, message: GoToPageCommand) {
        if (!message.cellId) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to navigate to page: No cell identifier provided. Please re-run the cell to update the output metadata.'
                )
            );
        }

        const cells = editor.notebook.getCells();
        const cell = cells.find((c) => c.metadata.id === message.cellId);

        if (!cell) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to navigate to page: Could not find the cell with ID {0}. The cell may have been deleted.',
                    message.cellId ?? ''
                )
            );
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

    private async handleSelectPageSize(editor: NotebookEditor, message: SelectPageSizeCommand) {
        if (!message.cellId) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to update page size: No cell identifier provided. Please re-run the cell to update the output metadata.'
                )
            );
        }

        const cells = editor.notebook.getCells();
        const cell = cells.find((c) => c.metadata.id === message.cellId);

        if (!cell) {
            return this.showErrorToUser(
                l10n.t(
                    'Unable to update page size: Could not find the cell with ID {0}. The cell may have been deleted.',
                    message.cellId ?? ''
                )
            );
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
        logger.info(`[DataframeController] Re-executing cell ${cellIndex} with new page size`);

        await commands.executeCommand('notebook.cell.execute', {
            ranges: [{ start: cellIndex, end: cellIndex + 1 }],
            document: editor.notebook.uri
        });
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

        if (message.command === 'copyTable') {
            return this.handleCopyTable(editor, message);
        }

        if (message.command === 'exportTable') {
            return this.handleExportTable(editor, message);
        }

        logger.warn(`DataframeController received unknown command:`, message);
    }

    private async showErrorToUser(errorMessage: string) {
        logger.error(`[DataframeController] ${errorMessage}`);

        await window.showErrorMessage(errorMessage);

        throw new Error(errorMessage);
    }
}
