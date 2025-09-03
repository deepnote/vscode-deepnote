// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { CustomNotebookData, CustomNotebookCell, CustomNotebookMessages } from '../../../extension-side/customNotebook/types';
import { CellContainer } from './CellContainer';
import { generateUuid } from '../../../../platform/common/uuid';

interface NotebookEditorProps {
    initialData: CustomNotebookData;
}

interface NotebookEditorState {
    notebookData: CustomNotebookData;
    selectedCellId: string | null;
    focusedCellId: string | null;
}

export class NotebookEditor extends React.Component<NotebookEditorProps, NotebookEditorState> {
    private readonly vscode = (window as any).acquireVsCodeApi();

    constructor(props: NotebookEditorProps) {
        super(props);
        
        this.state = {
            notebookData: props.initialData,
            selectedCellId: null,
            focusedCellId: null
        };

        // Listen for messages from the extension
        window.addEventListener('message', this.handleMessage);
    }

    override componentDidMount() {
        // Request the initial notebook data
        this.vscode.postMessage({
            command: CustomNotebookMessages.LoadNotebook
        });
    }

    override componentWillUnmount() {
        window.removeEventListener('message', this.handleMessage);
    }

    private handleMessage = (event: MessageEvent) => {
        const message = event.data;
        
        switch (message.command) {
            case CustomNotebookMessages.LoadNotebook:
            case CustomNotebookMessages.NotebookUpdated:
                this.setState({ notebookData: message.data });
                break;
        }
    };

    private handleCellUpdate = (cellId: string, updates: Partial<CustomNotebookCell>) => {
        // Update local state immediately for responsiveness
        this.setState(prevState => ({
            notebookData: {
                ...prevState.notebookData,
                cells: prevState.notebookData.cells.map(cell =>
                    cell.metadata.cell_id === cellId ? { ...cell, ...updates } : cell
                )
            }
        }));

        // Send update to extension
        this.vscode.postMessage({
            command: CustomNotebookMessages.UpdateCell,
            data: { cellId, cell: updates }
        });
    };

    private handleAddCell = (cellType: CustomNotebookCell['cell_type'] = 'code', index?: number) => {
        const newCell: CustomNotebookCell = {
            cell_type: cellType,
            metadata: {
                cell_id: generateUuid()
            },
            source: cellType === 'button' ? [] : ['']
        };

        // Add button-specific defaults
        if (cellType === 'button') {
            newCell.metadata.text = 'New Button';
            newCell.metadata.variant = 'primary';
            newCell.metadata.action = {
                type: 'set_variable',
                variable: 'button_clicked',
                value: true
            };
        }

        this.vscode.postMessage({
            command: CustomNotebookMessages.AddCell,
            data: { cell: newCell, index }
        });
    };

    private handleDeleteCell = (cellId: string) => {
        this.vscode.postMessage({
            command: CustomNotebookMessages.DeleteCell,
            data: { cellId }
        });
    };

    private handleMoveCell = (cellId: string, newIndex: number) => {
        this.vscode.postMessage({
            command: CustomNotebookMessages.MoveCell,
            data: { cellId, newIndex }
        });
    };

    private handleExecuteCell = (cellId: string, code: string) => {
        this.vscode.postMessage({
            command: CustomNotebookMessages.ExecuteCell,
            data: { cellId, code }
        });
    };

    private handleCellSelect = (cellId: string) => {
        this.setState({ selectedCellId: cellId });
    };

    private handleCellFocus = (cellId: string) => {
        this.setState({ focusedCellId: cellId });
    };

    private handleSave = () => {
        this.vscode.postMessage({
            command: CustomNotebookMessages.Save,
            data: this.state.notebookData
        });
    };

    override render() {
        const { notebookData, selectedCellId, focusedCellId } = this.state;

        return (
            <div className="notebook-editor">
                <div className="notebook-toolbar">
                    <button 
                        className="toolbar-button"
                        onClick={() => this.handleAddCell('code')}
                        title="Add Code Cell"
                    >
                        <span className="codicon codicon-add"></span>
                        Code
                    </button>
                    <button 
                        className="toolbar-button"
                        onClick={() => this.handleAddCell('markdown')}
                        title="Add Markdown Cell"
                    >
                        <span className="codicon codicon-add"></span>
                        Markdown
                    </button>
                    <button 
                        className="toolbar-button"
                        onClick={() => this.handleAddCell('button')}
                        title="Add Button Cell"
                    >
                        <span className="codicon codicon-add"></span>
                        Button
                    </button>
                    <div className="toolbar-separator"></div>
                    <button 
                        className="toolbar-button"
                        onClick={this.handleSave}
                        title="Save Notebook"
                    >
                        <span className="codicon codicon-save"></span>
                        Save
                    </button>
                </div>

                <div className="notebook-cells">
                    {notebookData.cells.map((cell, index) => (
                        <CellContainer
                            key={cell.metadata.cell_id || index}
                            cell={cell}
                            index={index}
                            isSelected={selectedCellId === cell.metadata.cell_id}
                            isFocused={focusedCellId === cell.metadata.cell_id}
                            onUpdate={(updates) => this.handleCellUpdate(cell.metadata.cell_id!, updates)}
                            onDelete={() => this.handleDeleteCell(cell.metadata.cell_id!)}
                            onMove={(newIndex) => this.handleMoveCell(cell.metadata.cell_id!, newIndex)}
                            onExecute={(code) => this.handleExecuteCell(cell.metadata.cell_id!, code)}
                            onSelect={() => this.handleCellSelect(cell.metadata.cell_id!)}
                            onFocus={() => this.handleCellFocus(cell.metadata.cell_id!)}
                        />
                    ))}

                    {notebookData.cells.length === 0 && (
                        <div className="empty-notebook">
                            <p>This notebook is empty.</p>
                            <button 
                                className="add-cell-button"
                                onClick={() => this.handleAddCell('code')}
                            >
                                <span className="codicon codicon-add"></span>
                                Add your first cell
                            </button>
                        </div>
                    )}
                </div>

                <style>{`
                    .notebook-editor {
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }

                    .notebook-toolbar {
                        display: flex;
                        align-items: center;
                        padding: 8px 16px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        background-color: var(--vscode-editor-background);
                        gap: 8px;
                    }

                    .toolbar-button {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        padding: 6px 12px;
                        border: 1px solid var(--vscode-button-border);
                        border-radius: 2px;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: 13px;
                        cursor: pointer;
                        outline: none;
                    }

                    .toolbar-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }

                    .toolbar-button:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                    }

                    .toolbar-separator {
                        width: 1px;
                        height: 20px;
                        background-color: var(--vscode-panel-border);
                        margin: 0 4px;
                    }

                    .notebook-cells {
                        flex: 1;
                        overflow-y: auto;
                        padding: 16px;
                    }

                    .empty-notebook {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 200px;
                        text-align: center;
                        color: var(--vscode-descriptionForeground);
                    }

                    .add-cell-button {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 8px 16px;
                        margin-top: 12px;
                        border: 1px solid var(--vscode-button-border);
                        border-radius: 2px;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        font-family: var(--vscode-font-family);
                        cursor: pointer;
                        outline: none;
                    }

                    .add-cell-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                `}</style>
            </div>
        );
    }
}