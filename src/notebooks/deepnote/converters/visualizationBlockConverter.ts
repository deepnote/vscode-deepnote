import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

/**
 * Converter for Deepnote visualization blocks (chart blocks).
 * Displays blocks as editable JSON with variable name, spec, and filters.
 * The JSON is converted to Python code at execution time.
 */
export class VisualizationBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Parse the JSON from the cell to update metadata
        try {
            const config = JSON.parse(cell.value || '{}');

            if (!block.metadata) {
                block.metadata = {};
            }

            if (config.variable) {
                block.metadata.deepnote_variable_name = config.variable;
            }

            if (config.spec) {
                block.metadata.deepnote_visualization_spec = config.spec;
            }

            if (config.filters) {
                if (!block.metadata.deepnote_chart_filter) {
                    block.metadata.deepnote_chart_filter = {};
                }
                block.metadata.deepnote_chart_filter.advancedFilters = config.filters;
            }
        } catch (error) {
            // If JSON parsing fails, leave metadata unchanged
            console.warn('Failed to parse visualization JSON:', error);
        }
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'visualization';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const variableName = (block.metadata as any)?.deepnote_variable_name || 'df';
        const spec = (block.metadata as any)?.deepnote_visualization_spec || {};
        const filters = (block.metadata as any)?.deepnote_chart_filter?.advancedFilters || [];

        // Create a clean JSON representation that users can edit
        const config = {
            variable: variableName,
            spec: spec,
            filters: filters
        };

        const jsonContent = JSON.stringify(config, null, 2);
        const cell = new NotebookCellData(NotebookCellKind.Code, jsonContent, 'python');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['visualization'];
    }
}
