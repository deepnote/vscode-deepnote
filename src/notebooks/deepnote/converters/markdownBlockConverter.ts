import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

export class MarkdownBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = cell.value || '';
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'markdown';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cell = new NotebookCellData(NotebookCellKind.Markup, block.content || '', 'markdown');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['markdown'];
    }
}
