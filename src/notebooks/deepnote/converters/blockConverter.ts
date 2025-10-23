import type { NotebookCellData } from 'vscode';

import type { DeepnoteBlock } from '../../../platform/deepnote/deepnoteTypes';

export interface BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void;
    canConvert(blockType: string): boolean;
    convertToCell(block: DeepnoteBlock): NotebookCellData;
    getSupportedTypes(): string[];
}
