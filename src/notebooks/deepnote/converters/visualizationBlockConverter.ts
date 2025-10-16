import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';

type DataframeFilter = {
    column: string;
    operator:
        | 'is-equal'
        | 'is-not-equal'
        | 'is-one-of'
        | 'is-not-one-of'
        | 'is-not-null'
        | 'is-null'
        | 'text-contains'
        | 'text-does-not-contain'
        | 'greater-than'
        | 'greater-than-or-equal'
        | 'less-than'
        | 'less-than-or-equal'
        | 'between'
        | 'outside-of'
        | 'is-relative-today'
        | 'is-after'
        | 'is-before'
        | 'is-on';
    comparativeValues: string[];
};

interface FilterMetadata {
    /** @deprecated Use advancedFilters instead */
    filter?: unknown;
    advancedFilters?: DataframeFilter[];
}

interface VisualizationCellMetadata {
    deepnote_variable_name?: string;
    deepnote_visualization_spec?: Record<string, unknown>;
    deepnote_chart_filter?: FilterMetadata;
}

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

            block.metadata = {
                ...block.metadata,
                deepnote_variable_name: config.variable || '',
                deepnote_visualization_spec: config.spec || {},
                deepnote_chart_filter: {
                    advancedFilters: config.filters || []
                }
            };
        } catch (error) {
            // If JSON parsing fails, leave metadata unchanged
            console.warn('Failed to parse visualization JSON:', error);
        }
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'visualization';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const metadata = block.metadata as VisualizationCellMetadata | undefined;
        const variableName = metadata?.deepnote_variable_name || 'df';
        const spec = metadata?.deepnote_visualization_spec || {};
        const filters = metadata?.deepnote_chart_filter?.advancedFilters || [];

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
