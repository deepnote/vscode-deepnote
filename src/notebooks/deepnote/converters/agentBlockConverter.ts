import type { DeepnoteBlock } from '@deepnote/blocks';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';

/** Agent prompts render as plaintext code cells; metadata passes through in DeepnoteDataConverter. */
export class AgentBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = cell.value;
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'agent';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cell = new NotebookCellData(NotebookCellKind.Code, block.content || '', 'plaintext');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['agent'];
    }
}
