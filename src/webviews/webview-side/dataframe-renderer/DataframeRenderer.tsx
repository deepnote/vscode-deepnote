import React from 'react';
import { memo, useMemo, useState } from 'react';
import type { RendererContext } from 'vscode-notebook-renderer';

import '../react-common/codicon/codicon.css';

export interface DataframeMetadata {
    table_state_spec?: string;
}

interface ColumnStats {
    unique_count: number;
    nan_count: number;
    min: string | null;
    max: string | null;
    histogram: Array<{
        bin_start: number;
        bin_end: number;
        count: number;
    }> | null;
    categories: Array<{
        name: string;
        count: number;
    }> | null;
}

interface DataframeRendererProps {
    cellId?: string;
    context: RendererContext<unknown>;
    data: {
        column_count: number;
        columns: {
            dtype: string;
            name: string;
            stats: ColumnStats;
        }[];
        preview_row_count: number;
        row_count: number;
        rows: {
            _deepnote_index_column: number;
            [key: string]: unknown;
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
    context,
    data,
    metadata
}: DataframeRendererProps) {
    console.log('[DataframeRenderer] Rendering dataframe', {
        cellId,
        data,
        metadata
    });

    const tableState = useMemo((): TableState => JSON.parse(metadata?.table_state_spec || '{}'), [metadata]);
    const [pageSize, setPageSize] = useState(tableState.pageSize || 10);
    const [pageIndex, setPageIndex] = useState(tableState.pageIndex || 0);

    console.log(
        `[DataframeRenderer] State: ${JSON.stringify(context.getState())}, tableState: ${JSON.stringify(tableState)}`
    );

    const filteredColumns = data.columns.filter((column) => !column.name.startsWith('_deepnote_'));
    const numberOfRows = Math.min(data.row_count, data.preview_row_count);
    const numberOfColumns = filteredColumns.length;

    const totalPages = Math.ceil(data.row_count / pageSize);

    const handlePageSizeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
        const newPageSize = Number(event.target.value);

        setPageSize(newPageSize);

        console.log(`[DataframeRenderer] handlePageSizeChange called with cellId: ${cellId}`);

        const message = {
            command: 'selectPageSize',
            cellId,
            size: newPageSize
        };

        console.log(`[DataframeRenderer] Posting message: ${JSON.stringify(message)}`);

        context.postMessage?.(message);
    };

    const handlePageChange = (newPageIndex: number) => {
        setPageIndex(newPageIndex);

        console.log(`[DataframeRenderer] handlePageChange called with cellId: ${cellId}, page: ${newPageIndex}`);

        const message = {
            command: 'goToPage',
            cellId,
            page: newPageIndex
        };

        console.log(`[DataframeRenderer] Posting message: ${JSON.stringify(message)}`);

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
                                            key={index.toString()}
                                            className={`p-[4px] border-b border-r border-[var(--vscode-panel-border)] font-mono ${
                                                index % 2 === 0
                                                    ? 'bg-[var(--vscode-editor-background)]'
                                                    : 'bg-[var(--vscode-list-hoverBackground)]/50'
                                            }`}
                                        >
                                            {value === null || value === undefined ? 'None' : String(value)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            <div className="px-[8px] py-[12px] flex justify-between items-center border-l border-r border-b border-[var(--vscode-panel-border)] font-mono">
                <div className="flex gap-[4px] items-center">
                    <div>
                        {numberOfRows} rows, {numberOfColumns} columns
                    </div>
                    <div className="dataframe-footer-controls">
                        <select
                            className="dataframe-page-size-select font-mono"
                            id="page-size-select"
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

                <div className="flex gap-[12px] items-center">
                    <button
                        aria-label="Previous page"
                        className={`
                            border border-[var(--vscode-panel-border)] bg-[var(--vscode-button-secondaryBackground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]
                            text-[var(--vscode-button-secondaryForeground)]
                            disabled:opacity-50 disabled:cursor-not-allowed
                            flex items-center justify-center
                            h-[20px] w-[20px]
                        `}
                        disabled={pageIndex === 0}
                        title="Previous page"
                        type="button"
                        onClick={() => handlePageChange(pageIndex - 1)}
                    >
                        <div className="codicon codicon-chevron-left" style={{ fontSize: 12 }} />
                    </button>
                    <span className="">
                        Page {pageIndex + 1} of {totalPages}
                    </span>
                    <button
                        aria-label="Next page"
                        className={`
                            border border-[var(--vscode-panel-border)] bg-[var(--vscode-button-secondaryBackground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]
                            text-[var(--vscode-button-secondaryForeground)]
                            disabled:opacity-50 disabled:cursor-not-allowed
                            flex items-center justify-center
                            h-[20px] w-[20px]
                        `}
                        disabled={pageIndex >= totalPages - 1}
                        title="Next page"
                        type="button"
                        onClick={() => handlePageChange(pageIndex + 1)}
                    >
                        <div className="codicon codicon-chevron-right" style={{ fontSize: 12 }} />
                    </button>
                </div>

                <div>{/* Actions */}</div>
            </div>
        </div>
    );
});
