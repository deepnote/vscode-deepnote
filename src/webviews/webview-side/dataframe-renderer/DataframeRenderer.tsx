import { clsx, type ClassValue } from 'clsx';
import React, { ReactElement, ReactNode } from 'react';
import { memo, useMemo, useState } from 'react';
import { twMerge } from 'tailwind-merge';
import type { RendererContext } from 'vscode-notebook-renderer';

import '../react-common/codicon/codicon.css';
import { generateUuid } from '../../../platform/common/uuid';
import { getLocString } from '../react-common/locReactSide';

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
        preview_row_count?: number;
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

    const selectId = useMemo(() => generateUuid(), []);

    const filteredColumns = data.columns.filter((column) => !column.name.startsWith('_deepnote_'));
    const numberOfRows = Number.isFinite(data.preview_row_count) ? data.preview_row_count : data.row_count;
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

    const handleCopyTable = () => {
        console.log(`[DataframeRenderer] handleCopyTable called with cellId: ${cellId}`);

        const message = {
            cellId,
            command: 'copyTable'
        };

        context.postMessage?.(message);
    };

    const handleExportTable = () => {
        console.log(`[DataframeRenderer] handleExportTable called with cellId: ${cellId}`);

        const message = {
            cellId,
            command: 'exportTable'
        };

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
                        {getLocString('dataframeRowsColumns', `{0} rows, {1} columns`)
                            .replace('{0}', String(numberOfRows))
                            .replace('{1}', String(numberOfColumns))}
                    </div>
                    <div>
                        <select className="font-mono" id={selectId} value={pageSize} onChange={handlePageSizeChange}>
                            <option value={10}>10</option>
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                        </select>

                        <label htmlFor={selectId}>{getLocString('dataframePerPage', '/ page')}</label>
                    </div>
                </div>

                <div className="flex gap-[12px] items-center">
                    <IconButton
                        aria-label={getLocString('dataframePreviousPage', 'Previous page')}
                        className={`
                            border border-[var(--vscode-panel-border)] bg-[var(--vscode-button-secondaryBackground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]
                            text-[var(--vscode-button-secondaryForeground)]
                            disabled:opacity-50 disabled:cursor-not-allowed
                            flex items-center justify-center
                            h-[20px] w-[20px]
                        `}
                        disabled={pageIndex === 0}
                        title={getLocString('dataframePreviousPage', 'Previous page')}
                        type="button"
                        onClick={() => handlePageChange(pageIndex - 1)}
                    >
                        <div className="codicon codicon-chevron-left" style={{ fontSize: 12 }} />
                    </IconButton>
                    <span className="">
                        {getLocString('dataframePageOf', 'Page {0} of {1}')
                            .replace('{0}', String(pageIndex + 1))
                            .replace('{1}', String(totalPages))}
                    </span>
                    <IconButton
                        aria-label={getLocString('dataframeNextPage', 'Next page')}
                        className={`
                            border border-[var(--vscode-panel-border)] bg-[var(--vscode-button-secondaryBackground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]
                            text-[var(--vscode-button-secondaryForeground)]
                            disabled:opacity-50 disabled:cursor-not-allowed
                            flex items-center justify-center
                            h-[20px] w-[20px]
                        `}
                        disabled={pageIndex >= totalPages - 1}
                        title={getLocString('dataframeNextPage', 'Next page')}
                        type="button"
                        onClick={() => handlePageChange(pageIndex + 1)}
                    >
                        <div className="codicon codicon-chevron-right" style={{ fontSize: 12 }} />
                    </IconButton>
                </div>

                <div>
                    <div className="flex items-center gap-[4px]">
                        <IconButton
                            aria-label={getLocString('dataframeCopyTable', 'Copy table')}
                            title={getLocString('dataframeCopyTable', 'Copy table')}
                            type="button"
                            onClick={handleCopyTable}
                        >
                            <div className="codicon codicon-files" style={{ fontSize: 12 }} />
                        </IconButton>

                        <IconButton
                            aria-label={getLocString('dataframeExportTable', 'Export table')}
                            title={getLocString('dataframeExportTable', 'Export table')}
                            type="button"
                            onClick={handleExportTable}
                        >
                            <div className="codicon codicon-arrow-down" style={{ fontSize: 12 }} />
                        </IconButton>
                    </div>
                </div>
            </div>
        </div>
    );
});

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    children: ReactNode;
}

function IconButton(props: IconButtonProps): ReactElement {
    return (
        <button
            className={cn(
                'border border-[var(--vscode-panel-border)] bg-[var(--vscode-button-secondaryBackground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]',
                'text-[var(--vscode-button-secondaryForeground)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'flex items-center justify-center',
                'h-[20px] w-[20px]',
                'cursor-pointer',
                props.className || ''
            )}
            {...props}
        >
            {props.children}
        </button>
    );
}

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
