// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from 'react';
import { CustomNotebookCell } from '../../../extension-side/customNotebook/types';

interface MarkdownCellProps {
    cell: CustomNotebookCell;
    onUpdate: (updates: Partial<CustomNotebookCell>) => void;
    onFocus: () => void;
    isSelected: boolean;
    isFocused: boolean;
}

export const MarkdownCell: React.FC<MarkdownCellProps> = ({
    cell,
    onUpdate,
    onFocus,
    isSelected,
    isFocused
}) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const previewRef = React.useRef<HTMLDivElement>(null);
    
    const [source, setSource] = React.useState<string>(() => 
        Array.isArray(cell.source) ? cell.source.join('') : cell.source
    );
    const [isEditing, setIsEditing] = React.useState(false);

    React.useEffect(() => {
        const newSource = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
        setSource(newSource);
    }, [cell.source]);

    React.useEffect(() => {
        if (isEditing && textareaRef.current) {
            textareaRef.current.focus();
            adjustTextareaHeight(textareaRef.current);
        }
    }, [isEditing]);

    const handleSourceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newSource = e.target.value;
        setSource(newSource);
        
        onUpdate({
            source: newSource.split('\n')
        });
    };

    const handleDoubleClick = () => {
        setIsEditing(true);
    };

    const handleBlur = () => {
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            setIsEditing(false);
        } else if (e.key === 'Enter' && e.ctrlKey) {
            setIsEditing(false);
        }
    };

    const adjustTextareaHeight = (textarea: HTMLTextAreaElement) => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.max(textarea.scrollHeight, 60)}px`;
    };

    // Simple markdown to HTML conversion (basic implementation)
    const markdownToHtml = (markdown: string): string => {
        let html = markdown;
        
        // Headers
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
        
        // Bold and italic
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Code blocks
        html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
        html = html.replace(/`(.*?)`/g, '<code>$1</code>');
        
        // Lists
        html = html.replace(/^\* (.*$)/gm, '<li>$1</li>');
        html = html.replace(/^(\d+)\. (.*$)/gm, '<li>$1. $2</li>');
        
        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        
        // Wrap lists
        html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
        
        return html;
    };

    if (isEditing) {
        return (
            <div 
                className={`markdown-cell editing ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
                onFocus={onFocus}
                tabIndex={0}
            >
                <div className="markdown-cell-toolbar">
                    <span className="cell-type-label">Markdown</span>
                    <span className="edit-hint">Press Ctrl+Enter or Esc to finish editing</span>
                </div>
                
                <textarea
                    ref={textareaRef}
                    value={source}
                    onChange={handleSourceChange}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    onInput={(e) => adjustTextareaHeight(e.currentTarget as HTMLTextAreaElement)}
                    placeholder="Enter markdown here..."
                    className="markdown-textarea"
                />

                <style>{`
                    .markdown-cell.editing {
                        border: 1px solid var(--vscode-focusBorder);
                        border-radius: 4px;
                        overflow: hidden;
                    }

                    .markdown-cell-toolbar {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        padding: 4px 8px;
                        background-color: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        font-size: 12px;
                    }

                    .cell-type-label {
                        color: var(--vscode-descriptionForeground);
                        font-family: var(--vscode-editor-font-family);
                        font-weight: 500;
                        text-transform: uppercase;
                    }

                    .edit-hint {
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        font-size: 11px;
                    }

                    .markdown-textarea {
                        width: 100%;
                        min-height: 60px;
                        padding: 12px;
                        border: none;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        font-family: var(--vscode-editor-font-family);
                        font-size: var(--vscode-editor-font-size);
                        line-height: 1.4;
                        resize: none;
                        outline: none;
                        overflow-y: auto;
                    }

                    .markdown-textarea::placeholder {
                        color: var(--vscode-input-placeholderForeground);
                        font-style: italic;
                    }
                `}</style>
            </div>
        );
    }

    return (
        <div 
            className={`markdown-cell preview ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}`}
            onFocus={onFocus}
            onDoubleClick={handleDoubleClick}
            tabIndex={0}
        >
            <div 
                ref={previewRef}
                className="markdown-preview"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(source) }}
            />
            
            {source.trim() === '' && (
                <div className="empty-markdown">
                    <span className="empty-text">Empty markdown cell</span>
                    <span className="edit-prompt">Double-click to edit</span>
                </div>
            )}

            <style>{`
                .markdown-cell.preview {
                    padding: 12px;
                    min-height: 40px;
                    border: 1px solid transparent;
                    border-radius: 4px;
                    outline: none;
                    cursor: text;
                }

                .markdown-cell.preview:hover {
                    border-color: var(--vscode-panel-border);
                    background-color: var(--vscode-list-hoverBackground);
                }

                .markdown-cell.preview:focus {
                    border-color: var(--vscode-focusBorder);
                    box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
                }

                .markdown-preview {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    line-height: 1.6;
                    color: var(--vscode-foreground);
                }

                .markdown-preview h1, 
                .markdown-preview h2, 
                .markdown-preview h3 {
                    margin: 0 0 12px 0;
                    color: var(--vscode-foreground);
                }

                .markdown-preview h1 {
                    font-size: 1.5em;
                    font-weight: 600;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 6px;
                }

                .markdown-preview h2 {
                    font-size: 1.3em;
                    font-weight: 600;
                }

                .markdown-preview h3 {
                    font-size: 1.1em;
                    font-weight: 600;
                }

                .markdown-preview p {
                    margin: 0 0 12px 0;
                }

                .markdown-preview code {
                    background-color: var(--vscode-textCodeBlock-background);
                    color: var(--vscode-textCodeBlock-foreground);
                    padding: 2px 4px;
                    border-radius: 2px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 0.9em;
                }

                .markdown-preview pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    color: var(--vscode-textCodeBlock-foreground);
                    padding: 12px;
                    border-radius: 4px;
                    overflow-x: auto;
                    margin: 12px 0;
                    font-family: var(--vscode-editor-font-family);
                }

                .markdown-preview pre code {
                    background: none;
                    padding: 0;
                }

                .markdown-preview ul, .markdown-preview ol {
                    margin: 12px 0;
                    padding-left: 24px;
                }

                .markdown-preview li {
                    margin: 4px 0;
                }

                .markdown-preview a {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: none;
                }

                .markdown-preview a:hover {
                    text-decoration: underline;
                }

                .markdown-preview strong {
                    font-weight: 600;
                }

                .markdown-preview em {
                    font-style: italic;
                }

                .empty-markdown {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 24px;
                    color: var(--vscode-descriptionForeground);
                    text-align: center;
                }

                .empty-text {
                    font-size: 14px;
                    margin-bottom: 4px;
                }

                .edit-prompt {
                    font-size: 12px;
                    font-style: italic;
                    opacity: 0.8;
                }
            `}</style>
        </div>
    );
};