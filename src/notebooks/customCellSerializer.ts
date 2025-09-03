// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import * as nbformat from '@jupyterlab/nbformat';

interface CustomCellMetadata {
    cellType?: string;
    [key: string]: any;
}

export class CustomNotebookSerializer implements vscode.NotebookSerializer {
    private readonly decoder = new TextDecoder();
    private readonly encoder = new TextEncoder();

    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken
    ): Promise<vscode.NotebookData> {
        const text = this.decoder.decode(content);
        const notebook = JSON.parse(text) as nbformat.INotebookContent;
        
        const cells = notebook.cells.map(cell => this.deserializeCell(cell));
        const notebookData = new vscode.NotebookData(cells);
        notebookData.metadata = notebook.metadata || {};
        
        return notebookData;
    }

    private deserializeCell(cell: nbformat.ICell): vscode.NotebookCellData {
        let cellData: vscode.NotebookCellData;
        const metadata: CustomCellMetadata = { ...cell.metadata };

        // Check for custom cell types
        if (cell.cell_type !== 'code' && cell.cell_type !== 'markdown' && cell.cell_type !== 'raw') {
            // Store custom type in metadata
            metadata.cellType = cell.cell_type;
            
            // For button cells, extract text from metadata
            let sourceText = '';
            if (cell.cell_type === 'button' && cell.metadata?.text) {
                sourceText = String(cell.metadata.text);
            } else if (cell.source) {
                sourceText = this.getSourceString(cell.source);
            }
            
            // Create a code cell that will output our custom renderer content
            cellData = new vscode.NotebookCellData(
                vscode.NotebookCellKind.Code,
                sourceText || '',
                'javascript'
            );

            // Add a custom output that our renderer will handle
            const customOutput = new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json(
                    {
                        cellType: cell.cell_type,
                        source: sourceText,
                        metadata: cell.metadata
                    },
                    'application/vnd.custom.cell'
                )
            ], {
                'application/vnd.custom.cell': {
                    cellType: cell.cell_type
                }
            });
            
            cellData.outputs = [customOutput];
        } else if (cell.cell_type === 'code') {
            cellData = new vscode.NotebookCellData(
                vscode.NotebookCellKind.Code,
                this.getSourceString(cell.source),
                this.getLanguageId(cell)
            );
            
            // Handle outputs for regular code cells
            if ((cell as nbformat.ICodeCell).outputs) {
                cellData.outputs = this.deserializeOutputs((cell as nbformat.ICodeCell).outputs);
            }
        } else {
            // Markdown or raw cells
            const cellKind = cell.cell_type === 'markdown' 
                ? vscode.NotebookCellKind.Markup 
                : vscode.NotebookCellKind.Code;
            
            cellData = new vscode.NotebookCellData(
                cellKind,
                this.getSourceString(cell.source),
                cell.cell_type === 'markdown' ? 'markdown' : 'raw'
            );
        }

        cellData.metadata = metadata;
        return cellData;
    }

    private deserializeOutputs(outputs: nbformat.IOutput[]): vscode.NotebookCellOutput[] {
        return outputs.map(output => {
            const items: vscode.NotebookCellOutputItem[] = [];
            
            if (output.output_type === 'stream') {
                const stream = output as nbformat.IStream;
                items.push(
                    vscode.NotebookCellOutputItem.text(
                        this.getMultilineString(stream.text),
                        stream.name === 'stderr' ? 'application/vnd.code.notebook.stderr' : 'application/vnd.code.notebook.stdout'
                    )
                );
            } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                const data = output as nbformat.IExecuteResult | nbformat.IDisplayData;
                if (data.data) {
                    for (const [mimeType, value] of Object.entries(data.data)) {
                        items.push(this.createOutputItem(mimeType, value));
                    }
                }
            } else if (output.output_type === 'error') {
                const error = output as nbformat.IError;
                items.push(
                    vscode.NotebookCellOutputItem.error({
                        name: error.ename,
                        message: error.evalue,
                        stack: error.traceback.join('\n')
                    })
                );
            }
            
            return new vscode.NotebookCellOutput(items);
        });
    }

    private createOutputItem(mimeType: string, value: any): vscode.NotebookCellOutputItem {
        if (typeof value === 'string') {
            return vscode.NotebookCellOutputItem.text(value, mimeType);
        } else {
            return vscode.NotebookCellOutputItem.json(value, mimeType);
        }
    }

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken
    ): Promise<Uint8Array> {
        const notebook: nbformat.INotebookContent = {
            cells: data.cells.map(cell => this.serializeCell(cell)),
            metadata: data.metadata || {},
            nbformat: 4,
            nbformat_minor: 4
        };
        
        const text = JSON.stringify(notebook, null, 2);
        return this.encoder.encode(text);
    }

    private serializeCell(cell: vscode.NotebookCellData): nbformat.ICell {
        const metadata = cell.metadata as CustomCellMetadata;
        
        // Check if this is a custom cell type
        if (metadata?.cellType) {
            // Serialize as custom cell type
            return {
                cell_type: metadata.cellType as any,
                source: this.splitMultilineString(cell.value),
                metadata: metadata
            };
        }

        // Regular cell serialization
        if (cell.kind === vscode.NotebookCellKind.Code) {
            const codeCell: nbformat.ICodeCell = {
                cell_type: 'code',
                source: this.splitMultilineString(cell.value),
                metadata: metadata || {},
                outputs: cell.outputs ? this.serializeOutputs(cell.outputs) : [],
                execution_count: null
            };
            return codeCell;
        } else {
            return {
                cell_type: 'markdown',
                source: this.splitMultilineString(cell.value),
                metadata: metadata || {}
            };
        }
    }

    private serializeOutputs(outputs: vscode.NotebookCellOutput[]): nbformat.IOutput[] {
        return outputs.flatMap(output => {
            return output.items.map(item => {
                if (item.mime.includes('error')) {
                    const error = item.data as any;
                    return {
                        output_type: 'error',
                        ename: error.name || '',
                        evalue: error.message || '',
                        traceback: (error.stack || '').split('\n')
                    } as nbformat.IError;
                } else if (item.mime.includes('stream')) {
                    return {
                        output_type: 'stream',
                        name: item.mime.includes('stderr') ? 'stderr' : 'stdout',
                        text: this.getCellOutputText(item) || ''
                    } as nbformat.IStream;
                } else {
                    return {
                        output_type: 'display_data',
                        data: {
                            [item.mime]: item.mime.includes('json') ? item.data : this.getCellOutputText(item)
                        },
                        metadata: {}
                    } as nbformat.IDisplayData;
                }
            });
        });
    }

    private getSourceString(source: nbformat.MultilineString): string {
        if (Array.isArray(source)) {
            return source.join('');
        }
        return source;
    }

    private getMultilineString(text: nbformat.MultilineString): string {
        if (Array.isArray(text)) {
            return text.join('');
        }
        return text;
    }

    private splitMultilineString(text: string): string[] {
        const lines = text.split('\n');
        return lines.map((line, index) => 
            index < lines.length - 1 ? line + '\n' : line
        ).filter(line => line.length > 0);
    }

    private getCellOutputText(item: vscode.NotebookCellOutputItem): string | undefined {
        try {
            return new TextDecoder().decode(item.data);
        } catch {
            return undefined;
        }
    }

    private getLanguageId(cell: nbformat.ICell): string {
        const metadata = cell.metadata as any;
        if (metadata?.language) {
            return metadata.language;
        }
        return 'python';
    }
}