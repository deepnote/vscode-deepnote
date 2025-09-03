// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { CustomNotebookCell } from '../../../extension-side/customNotebook/types';

interface CodeCellProps {
    cell: CustomNotebookCell;
    onUpdate: (updates: Partial<CustomNotebookCell>) => void;
    onFocus: () => void;
    onExecute: (code: string) => void;
    isSelected: boolean;
    isFocused: boolean;
    language?: string;
}

export const CodeCell: React.FC<CodeCellProps> = ({
    cell,
    onUpdate,
    onFocus,
    onExecute,
    isSelected,
    isFocused,
    language = 'python'
}) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const [source, setSource] = React.useState<string>(() => 
        Array.isArray(cell.source) ? cell.source.join('') : cell.source
    );

    React.useEffect(() => {
        const newSource = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        setSource(newSource);
    }, [cell.source]);

    React.useEffect(() => {
        if (isFocused && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isFocused]);

    const handleSourceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newSource = e.target.value;
        setSource(newSource);
        
        onUpdate({
            source: newSource.split('\n')
        });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            onExecute(source);
        } else if (e.key === 'Tab') {
            e.preventDefault();
            const textarea = e.currentTarget as HTMLTextAreaElement;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            
            const newValue = source.substring(0, start) + '    ' + source.substring(end);
            setSource(newValue);
            onUpdate({ source: newValue.split('\n') });
            
            // Set cursor position after the tab
            setTimeout(() => {
                textarea.selectionStart = textarea.selectionEnd = start + 4;
            }, 0);
        }
    };

    const handleRunClick = () => {
        onExecute(source);
    };

    const adjustTextareaHeight = (textarea: HTMLTextAreaElement) => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(textarea.scrollHeight, 100)}px`;
    };

    React.useEffect(() => {
        if (textareaRef.current) {
            adjustTextareaHeight(textareaRef.current);
        }
    }, [source]);

    return (
        <div 
            className={`code-cell ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
            onFocus={onFocus}
            tabIndex={0}
        >
            <div className="code-cell-toolbar">
                <span className="language-label">{language}</span>
                <button
                    className="run-button"
                    onClick={handleRunClick}
                    title="Run cell (Ctrl+Enter)"
                >
                    <span className="codicon codicon-play"></span>
                    Run
                </button>
            </div>

            <div className="code-cell-input">
                <textarea
                    ref={textareaRef}
                    value={source}
                    onChange={handleSourceChange}
                    onKeyDown={handleKeyDown}
                    onInput={(e) => adjustTextareaHeight(e.currentTarget as HTMLTextAreaElement)}
                    placeholder="Enter your code here..."
                    className="code-textarea"
                    spellCheck={false}
                />
            </div>

            <style>{`
                .code-cell {
                    outline: none;
                }

                .code-cell:focus-within {
                    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
                    border-radius: 4px;
                }

                .code-cell-toolbar {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4px 8px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-bottom: none;
                    border-radius: 4px 4px 0 0;
                    font-size: 12px;
                }

                .language-label {
                    color: var(--vscode-descriptionForeground);
                    font-family: var(--vscode-editor-font-family);
                    font-weight: 500;
                    text-transform: uppercase;
                }

                .run-button {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px 8px;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 2px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: 11px;
                    cursor: pointer;
                    outline: none;
                }

                .run-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .run-button:focus {
                    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
                }

                .code-cell-input {
                    position: relative;
                }

                .code-textarea {
                    width: 100%;
                    min-height: 100px;
                    padding: 12px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 0 0 4px 4px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    line-height: 1.4;
                    resize: none;
                    outline: none;
                    overflow-y: auto;
                    white-space: pre;
                    word-wrap: normal;
                    overflow-wrap: normal;
                }

                .code-textarea:focus {
                    border-color: var(--vscode-focusBorder);
                }

                .code-textarea::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                    font-style: italic;
                }

                /* Syntax highlighting hints for common languages */
                .code-textarea[data-language="python"] {
                    /* Future: Could integrate with Monaco editor for full syntax highlighting */
                }

                .code-textarea[data-language="javascript"] {
                    /* Future: Could integrate with Monaco editor for full syntax highlighting */
                }
            `}</style>
        </div>
    );
};