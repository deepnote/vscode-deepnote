// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { CustomNotebookCell } from '../../../extension-side/customNotebook/types';

interface ButtonCellProps {
    cell: CustomNotebookCell;
    onUpdate: (updates: Partial<CustomNotebookCell>) => void;
    onFocus: () => void;
    onClick: () => void;
    isSelected: boolean;
    isFocused: boolean;
}

export const ButtonCell: React.FC<ButtonCellProps> = ({
    cell,
    onUpdate,
    onFocus,
    onClick,
    isSelected,
    isFocused
}) => {
    const [isEditing, setIsEditing] = React.useState(false);
    const [editText, setEditText] = React.useState('');
    const [editVariant, setEditVariant] = React.useState<'primary' | 'secondary' | 'success' | 'danger'>('primary');

    // Get button text from different possible sources
    const getButtonText = (): string => {
        if (cell.metadata.text) return cell.metadata.text;
        if (cell.metadata.deepnote_button_title) return cell.metadata.deepnote_button_title;
        return 'Button';
    };

    // Get button variant/color scheme
    const getButtonVariant = (): string => {
        if (cell.metadata.variant) return cell.metadata.variant;
        if (cell.metadata.deepnote_button_color_scheme) {
            const colorMap: Record<string, string> = {
                'blue': 'primary',
                'green': 'success',
                'red': 'danger',
                'gray': 'secondary',
                'grey': 'secondary'
            };
            return colorMap[cell.metadata.deepnote_button_color_scheme] || 'primary';
        }
        return 'primary';
    };

    const buttonText = getButtonText();
    const buttonVariant = getButtonVariant();

    const handleDoubleClick = () => {
        setIsEditing(true);
        setEditText(buttonText);
        setEditVariant(buttonVariant as any);
    };

    const handleSaveEdit = () => {
        const updates: Partial<CustomNotebookCell> = {
            metadata: {
                ...cell.metadata,
                text: editText,
                variant: editVariant
            }
        };

        onUpdate(updates);
        setIsEditing(false);
    };

    const handleCancelEdit = () => {
        setIsEditing(false);
        setEditText(buttonText);
        setEditVariant(buttonVariant as any);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSaveEdit();
        } else if (e.key === 'Escape') {
            handleCancelEdit();
        }
    };

    const getButtonStyle = (variant: string): React.CSSProperties => {
        const baseStyle: React.CSSProperties = {
            padding: '12px 24px',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            fontFamily: 'var(--vscode-font-family)',
            transition: 'all 0.2s ease',
            outline: 'none',
            minWidth: '120px',
            position: 'relative'
        };

        switch (variant) {
            case 'primary':
                return {
                    ...baseStyle,
                    backgroundColor: '#007bff',
                    color: 'white'
                };
            case 'secondary':
                return {
                    ...baseStyle,
                    backgroundColor: '#6c757d',
                    color: 'white'
                };
            case 'success':
                return {
                    ...baseStyle,
                    backgroundColor: '#28a745',
                    color: 'white'
                };
            case 'danger':
                return {
                    ...baseStyle,
                    backgroundColor: '#dc3545',
                    color: 'white'
                };
            default:
                return {
                    ...baseStyle,
                    backgroundColor: '#007bff',
                    color: 'white'
                };
        }
    };

    if (isEditing) {
        return (
            <div className="button-cell-editor">
                <div className="editor-row">
                    <label>
                        Text:
                        <input
                            type="text"
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="text-input"
                        />
                    </label>
                </div>
                <div className="editor-row">
                    <label>
                        Variant:
                        <select
                            value={editVariant}
                            onChange={(e) => setEditVariant(e.target.value as any)}
                            className="variant-select"
                        >
                            <option value="primary">Primary</option>
                            <option value="secondary">Secondary</option>
                            <option value="success">Success</option>
                            <option value="danger">Danger</option>
                        </select>
                    </label>
                </div>
                <div className="editor-actions">
                    <button onClick={handleSaveEdit} className="save-button">
                        <span className="codicon codicon-check"></span>
                        Save
                    </button>
                    <button onClick={handleCancelEdit} className="cancel-button">
                        <span className="codicon codicon-close"></span>
                        Cancel
                    </button>
                </div>

                <style>{`
                    .button-cell-editor {
                        padding: 16px;
                        border: 1px solid var(--vscode-inputValidation-infoBorder);
                        border-radius: 4px;
                        background-color: var(--vscode-input-background);
                    }

                    .editor-row {
                        margin-bottom: 12px;
                    }

                    .editor-row label {
                        display: block;
                        margin-bottom: 4px;
                        font-size: 13px;
                        font-weight: 500;
                        color: var(--vscode-foreground);
                    }

                    .text-input, .variant-select {
                        width: 100%;
                        padding: 6px 8px;
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 2px;
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: 13px;
                        outline: none;
                    }

                    .text-input:focus, .variant-select:focus {
                        border-color: var(--vscode-focusBorder);
                        box-shadow: 0 0 0 1px var(--vscode-focusBorder);
                    }

                    .editor-actions {
                        display: flex;
                        gap: 8px;
                    }

                    .save-button, .cancel-button {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        padding: 6px 12px;
                        border: 1px solid var(--vscode-button-border);
                        border-radius: 2px;
                        font-family: var(--vscode-font-family);
                        font-size: 13px;
                        cursor: pointer;
                        outline: none;
                    }

                    .save-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }

                    .save-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }

                    .cancel-button {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }

                    .cancel-button:hover {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }
                `}</style>
            </div>
        );
    }

    return (
        <div 
            className={`button-cell ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
            onFocus={onFocus}
            onDoubleClick={handleDoubleClick}
            tabIndex={0}
        >
            <div className="button-cell-input">
                <button
                    style={getButtonStyle(buttonVariant)}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClick();
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.filter = 'brightness(1.1)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.filter = 'brightness(1)';
                    }}
                    className="custom-button"
                >
                    {buttonText}
                    {(cell.metadata.deepnote_cell_type === 'button' || cell.metadata.action?.type === 'set_variable') && (
                        <span className="button-icon">
                            <span className="codicon codicon-play"></span>
                        </span>
                    )}
                </button>
            </div>

            <div className="button-cell-info">
                <small className="cell-type-label">
                    Button Cell
                    {cell.metadata.deepnote_cell_type === 'button' && ' (Deepnote)'}
                </small>
                <div className="button-details">
                    {cell.metadata.action?.type === 'set_variable' && (
                        <small>Sets: {cell.metadata.action.variable} = {JSON.stringify(cell.metadata.action.value)}</small>
                    )}
                    {cell.metadata.deepnote_variable_name && (
                        <small>Sets: {cell.metadata.deepnote_variable_name} = True</small>
                    )}
                    <small>Double-click to edit</small>
                </div>
            </div>

            <style>{`
                .button-cell {
                    padding: 16px;
                    border-radius: 4px;
                    outline: none;
                }

                .button-cell:focus {
                    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
                }

                .button-cell-input {
                    display: flex;
                    justify-content: flex-start;
                    align-items: center;
                    margin-bottom: 12px;
                }

                .custom-button {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                .custom-button:focus {
                    box-shadow: 0 0 0 2px var(--vscode-focusBorder);
                }

                .custom-button:active {
                    transform: translateY(1px);
                }

                .button-icon {
                    opacity: 0.8;
                }

                .button-cell-info {
                    padding: 8px;
                    background-color: var(--vscode-textCodeBlock-background);
                    border: 1px solid var(--vscode-textBlockQuote-border);
                    border-radius: 4px;
                }

                .cell-type-label {
                    display: block;
                    font-weight: 600;
                    color: var(--vscode-textLink-foreground);
                    margin-bottom: 4px;
                }

                .button-details {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }

                .button-details small {
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                }
            `}</style>
        </div>
    );
};