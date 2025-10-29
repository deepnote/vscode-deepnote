import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../../../platform/deepnote/deepnoteTypes';
import { DeepnoteBigNumberMetadataSchema } from '../deepnoteSchemas';
import { DEEPNOTE_VSCODE_RAW_CONTENT_KEY } from './constants';

const DEFAULT_BIG_NUMBER_CONFIG = DeepnoteBigNumberMetadataSchema.parse({});

export class ChartBigNumberBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        // Parse the cell value as the value expression
        const valueExpression = cell.value.trim();

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        // Check if existing metadata is valid
        const existingMetadata = DeepnoteBigNumberMetadataSchema.safeParse(block.metadata);
        const hasValidMetadata =
            existingMetadata.success && block.metadata != null && Object.keys(block.metadata).length > 0;

        if (hasValidMetadata) {
            // Preserve existing metadata and only update the value
            block.metadata = {
                ...(block.metadata ?? {}),
                deepnote_big_number_value: valueExpression
            };
        } else {
            // Apply defaults when metadata is missing or invalid
            block.metadata = {
                ...DEFAULT_BIG_NUMBER_CONFIG,
                deepnote_big_number_value: valueExpression
            };
        }
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'big-number';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const deepnoteBigNumberMetadataResult = DeepnoteBigNumberMetadataSchema.safeParse(block.metadata);

        if (deepnoteBigNumberMetadataResult.error != null) {
            console.error('Error parsing deepnote big number metadata:', deepnoteBigNumberMetadataResult.error);
            console.debug('Metadata:', JSON.stringify(block.metadata));
        }

        // Show the value expression as cell content
        const valueExpression = deepnoteBigNumberMetadataResult.success
            ? deepnoteBigNumberMetadataResult.data.deepnote_big_number_value
            : DEFAULT_BIG_NUMBER_CONFIG.deepnote_big_number_value;

        const cell = new NotebookCellData(NotebookCellKind.Code, valueExpression, 'python');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['big-number'];
    }
}
