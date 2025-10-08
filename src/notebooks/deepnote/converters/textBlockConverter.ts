import { createMarkdown, stripMarkdown } from '@deepnote/blocks';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

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

        // Then strip the markdown formatting to get plain text
        const textValue = stripMarkdown(block);

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
