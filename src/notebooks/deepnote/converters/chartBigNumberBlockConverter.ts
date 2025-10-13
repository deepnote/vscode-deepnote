import { NotebookCellData, NotebookCellKind } from 'vscode';
import { z } from 'zod';

import type { BlockConverter } from './blockConverter';
import type { DeepnoteBlock } from '../deepnoteTypes';
import { DeepnoteBigNumberMetadataSchema } from '../deepnoteSchemas';
import { parseJsonWithFallback } from '../dataConversionUtils';
import { DEEPNOTE_VSCODE_RAW_CONTENT_KEY } from './constants';

const DEFAULT_BIG_NUMBER_CONFIG = DeepnoteBigNumberMetadataSchema.parse({});

export class ChartBigNumberBlockConverter implements BlockConverter {
    applyChangesToBlock(block: DeepnoteBlock, cell: NotebookCellData): void {
        block.content = '';

        const config = DeepnoteBigNumberMetadataSchema.safeParse(parseJsonWithFallback(cell.value));

        if (config.success !== true) {
            block.metadata = {
                ...block.metadata,
                [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: cell.value
            };

            return;
        }

        if (block.metadata != null) {
            delete block.metadata[DEEPNOTE_VSCODE_RAW_CONTENT_KEY];
        }

        block.metadata = {
            ...(block.metadata ?? {}),
            ...config.data
        };
    }

    canConvert(blockType: string): boolean {
        return blockType.toLowerCase() === 'big-number';
    }

    convertToCell(block: DeepnoteBlock): NotebookCellData {
        const deepnoteJupyterRawContentResult = z.string().safeParse(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY]);
        const deepnoteBigNumberMetadataResult = DeepnoteBigNumberMetadataSchema.safeParse(block.metadata);

        if (deepnoteBigNumberMetadataResult.error != null) {
            console.error('Error parsing deepnote big number metadata:', deepnoteBigNumberMetadataResult.error);
            console.debug('Metadata:', JSON.stringify(block.metadata));
        }

        const configStr = deepnoteJupyterRawContentResult.success
            ? deepnoteJupyterRawContentResult.data
            : deepnoteBigNumberMetadataResult.success
            ? JSON.stringify(deepnoteBigNumberMetadataResult.data, null, 2)
            : JSON.stringify(DEFAULT_BIG_NUMBER_CONFIG, null, 2);

        const cell = new NotebookCellData(NotebookCellKind.Code, configStr, 'json');

        return cell;
    }

    getSupportedTypes(): string[] {
        return ['big-number'];
    }
}
