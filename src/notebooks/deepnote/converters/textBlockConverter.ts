import { createMarkdown, DeepnoteBlock, stripMarkdown } from '@deepnote/blocks';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';

// Must remain the exact inverse of escapeMarkdown in @deepnote/blocks@4.3.0
// (identical character class). If a future library version unescapes inside
// stripMarkdown itself, this wrapper must be deleted — the round-trip unit
// tests fail loudly (double-unescape) in that case.
function unescapeMarkdown(text: string): string {
    return text.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');
}

export class TextBlockConverter implements BlockConverter {
    protected static readonly textBlockTypes = [
        'text-cell-h1',
        'text-cell-h2',
        'text-cell-h3',
        'text-cell-p',
        'text-cell-bullet',
        'text-cell-todo',
        'text-cell-callout',
        'separator'
    ];

    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        // For separator, just keep empty content
        if (block.type === 'separator') {
            block.content = '';

            return;
        }

        // Update block content with cell value first
        block.content = cell.value || '';

        // stripMarkdown's bullet regex only matches at column 0; indented bullets
        // (indent_level >= 1) render with leading spaces that must be trimmed first.
        if (block.type === 'text-cell-bullet') {
            block.content = block.content.trim();
        }

        // Then strip the markdown formatting to get plain text
        const textValue = unescapeMarkdown(stripMarkdown(block));

        block.content = textValue;
    }

    canConvert(blockType: string): boolean {
        return TextBlockConverter.textBlockTypes.includes(blockType.toLowerCase());
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const markdown = createMarkdown(block);

        const cell = new NotebookCellData(NotebookCellKind.Markup, markdown, 'markdown');

        return cell;
    }

    getSupportedTypes(): string[] {
        return [...TextBlockConverter.textBlockTypes];
    }
}
