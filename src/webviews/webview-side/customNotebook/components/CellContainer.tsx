// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { CustomNotebookCell } from '../../../extension-side/customNotebook/types';
import { ButtonCell } from './ButtonCell';
import { CodeCell } from './CodeCell';
import { MarkdownCell } from './MarkdownCell';

interface CellContainerProps {
    cell: CustomNotebookCell;
    index: number;
    isSelected: boolean;
    isFocused: boolean;
    onUpdate: (updates: Partial<CustomNotebookCell>) => void;
    onDelete: () => void;
    onMove: (newIndex: number) => void;
    onExecute: (code: string) => void;
    onSelect: () => void;
    onFocus: () => void;
}

export const CellContainer: React.FC<CellContainerProps> = ({
    cell,
    index,
    isSelected,
    isFocused,
    onUpdate,
    onDelete,
    onMove,
    onExecute,
    onSelect,
    onFocus
}) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [showActions, setShowActions] = React.useState(false);

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onSelect();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            // Ctrl+Enter to run cell
            if (cell.cell_type === 'code') {
                const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
                onExecute(source);
            } else if (cell.cell_type === 'button') {
                // Execute button action
                handleButtonClick();
            }
        } else if (e.key === 'Delete' && e.ctrlKey) {
            // Ctrl+Delete to delete cell
            onDelete();
        }
    };

    const handleButtonClick = () => {
        const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        if (source) {
            onExecute(source);
        }
        
        // Handle button-specific actions
        if (cell.metadata.action) {
            const { action } = cell.metadata;
            if (action.type === 'set_variable' && action.variable) {
                const code = `${action.variable} = ${JSON.stringify(action.value)}`;
                onExecute(code);
            }
        }

        // Handle Deepnote-style buttons
        if (cell.metadata.deepnote_cell_type === 'button' && cell.metadata.deepnote_variable_name) {
            const code = `${cell.metadata.deepnote_variable_name} = True`;
            onExecute(code);
        }
    };

    const renderCellContent = () => {
        const commonProps = {
            cell,
            onUpdate,
            onFocus,
            isSelected,
            isFocused
        };

        // Check for button cells (both direct and Deepnote-style)
        if (cell.cell_type === 'button' || cell.metadata.deepnote_cell_type === 'button') {
            return (
                <ButtonCell
                    {...commonProps}
                    onClick={handleButtonClick}
                />
            );
        }

        switch (cell.cell_type) {
            case 'code':
                return (
                    <CodeCell
                        {...commonProps}
                        onExecute={onExecute}
                    />
                );
            case 'markdown':
                return (
                    <MarkdownCell
                        {...commonProps}
                    />
                );
            case 'raw':
                return (
                    <CodeCell
                        {...commonProps}
                        onExecute={onExecute}
                        language="text"
                    />
                );
            default:
                return (
                    <div className="cell-content unknown-cell">
                        <div className="unknown-cell-header">
                            Unknown cell type: {cell.cell_type}
                        </div>
                        <pre className="unknown-cell-source">
                            {Array.isArray(cell.source) ? cell.source.join('') : cell.source}
                        </pre>
                    </div>
                );
        }
    };

    return (
        <div
            ref={containerRef}
            className={`cell-container ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onMouseEnter={() => setShowActions(true)}
            onMouseLeave={() => setShowActions(false)}
            tabIndex={0}
        >
            <div className="cell-sidebar">
                <div className="cell-execution-order">
                    {cell.execution_count !== undefined ? `[${cell.execution_count || ' '}]` : '[ ]'}
                </div>
            </div>

            <div className="cell-main">
                {renderCellContent()}

                {cell.outputs && cell.outputs.length > 0 && (
                    <div className="cell-outputs">
                        {cell.outputs.map((output, outputIndex) => (
                            <div key={outputIndex} className="cell-output">
                                <pre>{JSON.stringify(output, null, 2)}</pre>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {(showActions || isSelected) && (
                <div className="cell-actions">
                    <button
                        className="cell-action-button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onMove(index - 1);
                        }}
                        disabled={index === 0}
                        title="Move up"
                    >
                        <span className="codicon codicon-chevron-up"></span>
                    </button>
                    <button
                        className="cell-action-button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onMove(index + 1);
                        }}
                        title="Move down"
                    >
                        <span className="codicon codicon-chevron-down"></span>
                    </button>
                    <button
                        className="cell-action-button delete"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete();
                        }}
                        title="Delete cell"
                    >
                        <span className="codicon codicon-trash"></span>
                    </button>
                </div>
            )}

            <style>{`
                .cell-container {
                    display: flex;
                    margin-bottom: 16px;
                    padding: 8px;
                    border: 1px solid transparent;
                    border-radius: 4px;
                    position: relative;
                    outline: none;
                }

                .cell-container:hover {
                    border-color: var(--vscode-focusBorder);
                }

                .cell-container.selected {
                    border-color: var(--vscode-focusBorder);
                    background-color: var(--vscode-list-activeSelectionBackground);
                }

                .cell-container.focused {
                    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
                }

                .cell-sidebar {
                    width: 60px;
                    display: flex;
                    align-items: flex-start;
                    padding-top: 8px;
                }

                .cell-execution-order {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    text-align: right;
                    width: 100%;
                }

                .cell-main {
                    flex: 1;
                    min-width: 0;
                }

                .cell-outputs {
                    margin-top: 8px;
                    border-top: 1px solid var(--vscode-panel-border);
                    padding-top: 8px;
                }

                .cell-output {
                    margin-bottom: 8px;
                }

                .cell-output pre {
                    margin: 0;
                    padding: 8px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border: 1px solid var(--vscode-textBlockQuote-border);
                    border-radius: 4px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    white-space: pre-wrap;
                    word-wrap: break-word;
                }

                .cell-actions {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    display: flex;
                    gap: 4px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    padding: 4px;
                }

                .cell-action-button {
                    padding: 4px;
                    border: none;
                    border-radius: 2px;
                    background-color: transparent;
                    color: var(--vscode-icon-foreground);
                    cursor: pointer;
                    outline: none;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .cell-action-button:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }

                .cell-action-button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .cell-action-button.delete:hover {
                    background-color: var(--vscode-errorForeground);
                    color: white;
                }

                .unknown-cell {
                    padding: 8px;
                    border: 1px solid var(--vscode-errorBorder);
                    border-radius: 4px;
                    background-color: var(--vscode-inputValidation-errorBackground);
                }

                .unknown-cell-header {
                    font-weight: bold;
                    color: var(--vscode-errorForeground);
                    margin-bottom: 8px;
                }

                .unknown-cell-source {
                    margin: 0;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 8px;
                    border-radius: 4px;
                }
            `}</style>
        </div>
    );
};