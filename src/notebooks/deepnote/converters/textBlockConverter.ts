import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

export class TextBlockConverter implements BlockConverter {
    protected static readonly textBlockTypes = ['text-cell-h1', 'text-cell-h2', 'text-cell-h3', 'text-cell-p'];

    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        let value = cell.value || '';

        if (block.type === 'text-cell-h1') {
            value = value.replace(/^\s*#\s+/, '');
        } else if (block.type === 'text-cell-h2') {
            value = value.replace(/^\s*##\s+/, '');
        } else if (block.type === 'text-cell-h3') {
            value = value.replace(/^\s*###\s+/, '');
        }

        block.content = value;
    }

    canConvert(blockType: string): boolean {
        return TextBlockConverter.textBlockTypes.includes(blockType.toLowerCase());
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        // TODO: Use the library to handle the markdown conversion here in the future.

        let value = block.content || '';

        if (block.type === 'text-cell-h1') {
            value = `# ${value}`;
        } else if (block.type === 'text-cell-h2') {
            value = `## ${value}`;
        } else if (block.type === 'text-cell-h3') {
            value = `### ${value}`;
        }

        const cell = new NotebookCellData(NotebookCellKind.Markup, value, 'markdown');

        return cell;
    }

    getSupportedTypes(): string[] {
        return [...TextBlockConverter.textBlockTypes];
    }
}
