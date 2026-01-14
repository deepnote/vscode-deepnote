import type { DeepnoteBlock } from '@deepnote/blocks';
import { NotebookCellKind, type NotebookCellData } from 'vscode';

import { generateBlockId, generateSortingKey } from '../../notebooks/deepnote/dataConversionUtils';
import { logger } from '../logging';
import { generateUuid } from '../common/uuid';

// Note: 'id' is intentionally excluded from this list so it remains at the top level of cell.metadata
// The id field is needed at runtime for cell identification during execution
// Note: 'outputs' is also excluded because VS Code manages outputs natively through cell.outputs
const deepnoteBlockSpecificFields = [
    'blockGroup',
    'contentHash',
    'executionCount',
    'executionFinishedAt',
    'executionStartedAt',
    'sortingKey',
    'type'
] as const;

// Stores extra Deepnote-specific fields for each block that are not part of the standard VSCode NotebookCellData structure.
// Note: 'id' and 'outputs' are not in the pocket - they are managed by VS Code natively
export interface Pocket {
    blockGroup?: string;
    /** SHA-256 hash of block content (prefixed with "sha256:") */
    contentHash?: string;
    executionCount?: number;
    /** ISO 8601 timestamp when block execution finished */
    executionFinishedAt?: string;
    /** ISO 8601 timestamp when block execution started */
    executionStartedAt?: string;
    sortingKey?: string;
    type?: string;
}

export function addPocketToCellMetadata(cell: NotebookCellData): void {
    const src: Record<string, unknown> = cell.metadata ? { ...cell.metadata } : {};
    const pocket: Pocket = {};
    let found = false;

    logger.debug(`[Pocket] addPocketToCellMetadata: input id=${src.id}, keys=${Object.keys(src).join(',')}`);

    for (const field of deepnoteBlockSpecificFields) {
        if (Object.prototype.hasOwnProperty.call(src, field)) {
            const value = src[field];
            (pocket as Record<string, unknown>)[field] = value;
            delete src[field];
            found = true;
        }
    }

    if (!found) {
        logger.debug(`[Pocket] addPocketToCellMetadata: no pocket fields found, preserving id=${src.id}`);

        return;
    }

    cell.metadata = {
        ...src,
        __deepnotePocket: pocket
    };

    logger.debug(
        `[Pocket] addPocketToCellMetadata: output id=${cell.metadata.id}, pocket keys=${Object.keys(pocket).join(',')}}`
    );
}

export function extractPocketFromCellMetadata(cell: NotebookCellData): Pocket | undefined {
    return cell.metadata?.__deepnotePocket;
}

export function createBlockFromPocket(cell: NotebookCellData, index: number): DeepnoteBlock {
    const pocket = extractPocketFromCellMetadata(cell);

    const metadata = cell.metadata ? { ...cell.metadata } : undefined;
    // Get id from top-level metadata before cleaning it up
    // Check both 'id' and backup '__deepnoteBlockId' in case VS Code modifies 'id'
    const cellId = (metadata?.id as string | undefined) || (metadata?.__deepnoteBlockId as string | undefined);

    logger.debug(
        `[Pocket] createBlockFromPocket index=${index}: cell.metadata.id=${metadata?.id}, __deepnoteBlockId=${metadata?.__deepnoteBlockId}, using cellId=${cellId}, metadata keys=${
            metadata ? Object.keys(metadata).join(',') : 'none'
        }`
    );

    if (metadata) {
        // Remove pocket and all pocket fields from metadata
        delete metadata.__deepnotePocket;
        // Also remove id and backup id from metadata as it goes into block.id
        delete metadata.id;
        delete metadata.__deepnoteBlockId;

        for (const field of deepnoteBlockSpecificFields) {
            delete metadata[field];
        }
    }

    // Determine the block type:
    // 1. Use the type from the pocket if available
    // 2. Otherwise, infer from the cell kind (Code -> 'code', Markup -> 'markdown')
    const defaultType = cell.kind === NotebookCellKind.Code ? 'code' : 'markdown';

    const block: DeepnoteBlock = {
        blockGroup: pocket?.blockGroup || generateUuid(),
        content: cell.value,
        id: cellId || generateBlockId(),
        metadata,
        sortingKey: pocket?.sortingKey || generateSortingKey(index),
        type: pocket?.type || defaultType
    };

    if (pocket?.contentHash !== undefined) {
        block.contentHash = pocket.contentHash;
    }

    if (pocket?.executionCount !== undefined) {
        block.executionCount = pocket.executionCount;
    }

    if (pocket?.executionFinishedAt !== undefined) {
        block.executionFinishedAt = pocket.executionFinishedAt;
    }

    if (pocket?.executionStartedAt !== undefined) {
        block.executionStartedAt = pocket.executionStartedAt;
    }

    return block;
}
