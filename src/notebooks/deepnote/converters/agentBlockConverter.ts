import type { DeepnoteBlock } from '@deepnote/blocks';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';

/**
 * Converter for agent blocks.
 *
 * Agent blocks are rendered as code cells with markdown language so the natural-language
 * prompt gets reasonable syntax highlighting while remaining visually distinct from
 * Python code blocks. The prompt text is stored in `block.content`.
 *
 * Agent-specific metadata (model, MCP servers, max iterations, etc.) is preserved
 * through the generic metadata pass-through in DeepnoteDataConverter.
 */
export class AgentBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = cell.value || '';
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'agent';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const cell = new NotebookCellData(NotebookCellKind.Code, block.content || '', 'markdown');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['agent'];
    }
}
