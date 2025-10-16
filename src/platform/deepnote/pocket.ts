import type { NotebookCellData } from 'vscode';

import type { DeepnoteBlock } from './deepnoteTypes';
import { generateBlockId, generateSortingKey } from '../../notebooks/deepnote/dataConversionUtils';

// Note: 'id' is intentionally excluded from this list so it remains at the top level of cell.metadata
// The id field is needed at runtime for cell identification during execution
// Note: 'outputs' is also excluded because VS Code manages outputs natively through cell.outputs
const deepnoteBlockSpecificFields = ['blockGroup', 'executionCount', 'sortingKey', 'type'] as const;

// Stores extra Deepnote-specific fields for each block that are not part of the standard VSCode NotebookCellData structure.
// Note: 'id' and 'outputs' are not in the pocket - they are managed by VS Code natively
export interface Pocket {
    blockGroup?: string;
    executionCount?: number;
    sortingKey?: string;
    type?: string;
}

export function addPocketToCellMetadata(cell: NotebookCellData): void {
    const src: Record<string, unknown> = cell.metadata ? { ...cell.metadata } : {};
    const pocket: Pocket = {};
    let found = false;

    for (const field of deepnoteBlockSpecificFields) {
        if (Object.prototype.hasOwnProperty.call(src, field)) {
            const value = src[field];
            (pocket as Record<string, unknown>)[field] = value;
            delete src[field];
            found = true;
        }
    }

    if (!found) {
        return;
    }

    cell.metadata = {
        ...src,
        __deepnotePocket: pocket
    };
}

export function extractPocketFromCellMetadata(cell: NotebookCellData): Pocket | undefined {
    return cell.metadata?.__deepnotePocket;
}

export function createBlockFromPocket(cell: NotebookCellData, index: number): DeepnoteBlock {
    const pocket = extractPocketFromCellMetadata(cell);

    const metadata = cell.metadata ? { ...cell.metadata } : undefined;
    // Get id from top-level metadata before cleaning it up
    const cellId = metadata?.id as string | undefined;

    if (metadata) {
        // Remove pocket and all pocket fields from metadata
        delete metadata.__deepnotePocket;
        // Also remove id from metadata as it goes into block.id
        delete metadata.id;

        for (const field of deepnoteBlockSpecificFields) {
            delete metadata[field];
        }
    }

    const block: DeepnoteBlock = {
        blockGroup: pocket?.blockGroup || 'default-group',
        content: cell.value,
        id: cellId || generateBlockId(),
        metadata,
        sortingKey: pocket?.sortingKey || generateSortingKey(index),
        type: pocket?.type || 'code'
    };

    if (pocket?.executionCount !== undefined) {
        block.executionCount = pocket.executionCount;
    }

    return block;
}
