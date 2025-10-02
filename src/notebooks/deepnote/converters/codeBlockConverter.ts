import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

export class CodeBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = cell.value || '';
    }

    canConvert(blockType: string): boolean {
        return blockType === 'code';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cell = new NotebookCellData(NotebookCellKind.Code, block.content || '', 'python');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['code'];
    }
}
