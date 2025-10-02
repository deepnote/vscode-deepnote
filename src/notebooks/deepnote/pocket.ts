import type { NotebookCellData } from 'vscode';

import type { DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';
import { generateBlockId, generateSortingKey } from './dataConversionUtils';

const deepnoteBlockSpecificFields: string[] = ['blockGroup', 'executionCount', 'id', 'outputs', 'sortingKey', 'type'];

// Stores extra Deepnote-specific fields for each block that are not part of the standard VSCode NotebookCellData structure.
export interface Pocket {
    blockGroup?: string;
    executionCount?: number;
    id?: string;
    outputs?: DeepnoteOutput[];
    sortingKey?: string;
    type?: string;
}

export function addPocketToCellMetadata(cell: NotebookCellData): void {
    const pocket: Pocket = {};

    for (const field of deepnoteBlockSpecificFields) {
        if (cell.metadata && field in cell.metadata) {
            pocket[field as keyof Pocket] = cell.metadata[field];
        }
    }

    if (Object.keys(pocket).length === 0) {
        return;
    }

    cell.metadata = {
        ...cell.metadata,
        __deepnotePocket: pocket
    };
}

export function extractPocketFromCellMetadata(cell: NotebookCellData): Pocket | undefined {
    return cell.metadata?.__deepnotePocket;
}

export function createBlockFromPocket(cell: NotebookCellData, index: number): DeepnoteBlock {
    const pocket = extractPocketFromCellMetadata(cell);

    const metadata = cell.metadata ? { ...cell.metadata } : undefined;

    if (metadata) {
        // Remove pocket and all pocket fields from metadata
        delete metadata.__deepnotePocket;

        for (const field of deepnoteBlockSpecificFields) {
            delete metadata[field];
        }
    }

    const block: DeepnoteBlock = {
        content: '',
        id: pocket?.id || generateBlockId(),
        metadata,
        sortingKey: pocket?.sortingKey || generateSortingKey(index),
        type: pocket?.type || 'code'
    };

    // Only add optional fields if they exist
    if (pocket?.blockGroup) {
        (block as DeepnoteBlock & { blockGroup?: string }).blockGroup = pocket.blockGroup;
    }

    if (pocket?.executionCount !== undefined) {
        block.executionCount = pocket.executionCount;
    }

    if (pocket?.outputs !== undefined) {
        block.outputs = pocket.outputs;
    }

    return block;
}
