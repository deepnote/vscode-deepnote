import React, { memo, useMemo, useState } from 'react';
import { RendererContext } from 'vscode-notebook-renderer';

export interface DataframeMetadata {
    table_state_spec?: string;
}

interface DataframeRendererProps {
    cellId?: string;
    cellIndex?: number;
    context: RendererContext<unknown>;
    data: {
        column_count: number;
        columns: {
            dtype: string;
            name: string;
            stats: any;
        }[];
        preview_row_count: number;
        row_count: number;
        rows: {
            _deepnote_index_column: number;
            [key: string]: any;
        }[];
        type: string;
    };
    metadata?: DataframeMetadata;
}

interface TableState {
    columnOrder: string[];
    pageIndex: number;
    pageSize: number;
    sortBy: { id: string; type: string }[];
}

export const DataframeRenderer = memo(function DataframeRenderer({
    cellId,
    cellIndex,
    context,
    data,
    metadata
}: DataframeRendererProps) {
    console.log('[DataframeRenderer] Rendering with:', { cellId, cellIndex, data, metadata });

    const tableState = useMemo((): TableState => JSON.parse(metadata?.table_state_spec || '{}'), [metadata]);
    const [pageSize, setPageSize] = useState(tableState.pageSize || 10);

    console.log({ state: context.getState(), tableState });

    const filteredColumns = data.columns.filter((column) => !column.name.startsWith('_deepnote_'));
    const numberOfRows = Math.min(data.row_count, data.preview_row_count);
    const numberOfColumns = filteredColumns.length;

    const handlePageSizeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
        const newPageSize = Number(event.target.value);

        setPageSize(newPageSize);

        console.log('[DataframeRenderer] handlePageSizeChange called with cellId:', cellId, 'cellIndex:', cellIndex);

        const message = {
            command: 'selectPageSize',
            cellId,
            cellIndex,
            size: newPageSize
        };

        console.log('[DataframeRenderer] Posting message:', message);

        context.postMessage?.(message);
    };

    return (
        <div className="w-full">
            <div className="w-full overflow-x-auto">
                <div className="flex border-l border-[var(--vscode-panel-border)]">
                    {filteredColumns.map((column) => {
                        const rows = data.rows.map((row) => row[column.name]);

                        return (
                            <div key={column.name} className="flex-none flex-grow-1">
                                <div className="flex gap-[4px] p-[4px] border-b border-r border-t border-[var(--vscode-panel-border)] font-mono">
                                    <div className="font-[600]">{column.name}</div>
                                    <div className="">{column.dtype}</div>
                                </div>
                                <div className="">
                                    {rows.map((value, index) => (
                                        <div
                                            key={index}
                                            className={`p-[4px] border-b border-r border-[var(--vscode-panel-border)] font-mono ${
                                                index % 2 === 0
                                                    ? 'bg-[var(--vscode-editor-background)]'
                                                    : 'bg-[var(--vscode-list-hoverBackground)]/50'
                                            }`}
                                        >
                                            {value ? value.toString() : 'None'}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            <div className="px-[8px] py-[4px] flex justify-between items-center border-l border-r border-b border-[var(--vscode-panel-border)] font-mono">
                <div className="flex gap-[4px] items-center">
                    <div>
                        {numberOfRows} rows, {numberOfColumns} columns
                    </div>
                    <div className="dataframe-footer-controls">
                        <select
                            id="page-size-select"
                            className="dataframe-page-size-select font-mono"
                            value={pageSize}
                            onChange={handlePageSizeChange}
                        >
                            <option value={10}>10</option>
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                        </select>

                        <label htmlFor="page-size-select" className="dataframe-footer-label">
                            / page
                        </label>
                    </div>
                </div>

                <div></div>
            </div>
        </div>
    );
});
