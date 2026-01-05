import type { DeepnoteBlock } from '@deepnote/blocks';
import type { NotebookCellData } from 'vscode';

export interface BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void;
    canConvert(blockType: string): boolean;
    convertToCell(block: DeepnoteBlock): NotebookCellData;
    getSupportedTypes(): string[];
}
