import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../../../platform/deepnote/deepnoteTypes';

/**
 * Converter for SQL blocks.
 *
 * SQL blocks are rendered as code cells with SQL language for proper syntax highlighting.
 * The SQL source code is stored in the cell content and displayed in the code editor.
 *
 * During execution, the createPythonCode function from @deepnote/blocks will generate
 * the appropriate Python code to execute the SQL query based on the block's metadata
 * (which includes the sql_integration_id and other SQL-specific settings).
 */
export class SqlBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        // Store the SQL source code from the cell editor back to the block
        block.content = cell.value || '';
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'sql';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        // Create a code cell with SQL language for syntax highlighting
        // The SQL source code is displayed in the editor
        const cell = new NotebookCellData(NotebookCellKind.Code, block.content || '', 'sql');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['sql'];
    }
}
