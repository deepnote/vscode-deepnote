import React, { memo, useState } from 'react';
import { RendererContext } from 'vscode-notebook-renderer';

interface DataframeRendererProps {
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
}

export const DataframeRenderer = memo(function DataframeRenderer({ context, data }: DataframeRendererProps) {
    const [resultsPerPage, setResultsPerPage] = useState(10);

    const filteredColumns = data.columns.filter((column) => !column.name.startsWith('_deepnote_'));
    const numberOfRows = Math.min(data.row_count, data.preview_row_count);
    const numberOfColumns = filteredColumns.length;

    const updateCellMetadata = (metadata: Record<string, any>) => {
        if (context.postMessage) {
            context.postMessage({
                command: 'updateCellMetadata',
                cellIndex: 0, // or get the actual cell index
                metadata: metadata
            });
        }
    };

    return (
        <div className="dataframe-container">
            <button onClick={() => updateCellMetadata({ customField: 'value' })}>Update Metadata</button>
            <div className="dataframe-content">
                {filteredColumns.map((column) => {
                    const rows = data.rows.map((row) => row[column.name]);

                    return (
                        <div key={column.name} className="dataframe-column">
                            <div className="dataframe-header">{column.name}</div>
                            <div className="dataframe-cells">
                                {rows.map((value, index) => (
                                    <div key={index} className="dataframe-cell">
                                        {value ? value.toString() : 'None'}
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="dataframe-footer">
                <div>
                    {numberOfRows} rows, {numberOfColumns} columns
                </div>
                <div></div>
                <div></div>
            </div>
        </div>
    );
});
