import type { DeepnoteBlock } from '@deepnote/blocks';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';

export class CodeBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = cell.value || '';
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'code';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cell = new NotebookCellData(NotebookCellKind.Code, block.content || '', 'python');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['code'];
    }
}
