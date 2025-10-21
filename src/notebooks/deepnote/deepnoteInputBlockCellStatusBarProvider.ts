// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    Disposable,
    notebooks,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider
} from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { injectable } from 'inversify';
import type { Pocket } from '../../platform/deepnote/pocket';

/**
 * Provides status bar items for Deepnote input block cells to display their block type.
 * Shows the type of input (e.g., "input-text", "input-slider", "button") in the cell status bar.
 */
@injectable()
export class DeepnoteInputBlockCellStatusBarItemProvider
    implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService
{
    private readonly disposables: Disposable[] = [];

    // List of supported Deepnote input block types
    private readonly INPUT_BLOCK_TYPES = [
        'input-text',
        'input-textarea',
        'input-select',
        'input-slider',
        'input-checkbox',
        'input-date',
        'input-date-range',
        'input-file',
        'button'
    ];

    activate(): void {
        // Register the status bar item provider for Deepnote notebooks
        this.disposables.push(notebooks.registerNotebookCellStatusBarItemProvider('deepnote', this));
    }

    provideCellStatusBarItems(cell: NotebookCell): NotebookCellStatusBarItem | undefined {
        // Check if this cell is a Deepnote input block
        // Get the block type from the __deepnotePocket metadata field
        const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;
        const blockType = pocket?.type;

        if (!blockType || !this.isInputBlock(blockType)) {
            return undefined;
        }

        const formattedName = this.formatBlockTypeName(blockType);

        // Create a status bar item showing the block type
        // Using alignment value 2 (NotebookCellStatusBarAlignment.Right)
        const statusBarItem: NotebookCellStatusBarItem = {
            text: formattedName,
            alignment: 2, // NotebookCellStatusBarAlignment.Right
            tooltip: `Deepnote ${formattedName}`
        };

        return statusBarItem;
    }

    /**
     * Checks if the given block type is a Deepnote input block
     */
    private isInputBlock(blockType: string): boolean {
        return this.INPUT_BLOCK_TYPES.includes(blockType.toLowerCase());
    }

    /**
     * Formats the block type name for display (e.g., "input-text" -> "Input Text")
     */
    private formatBlockTypeName(blockType: string): string {
        return blockType
            .split('-')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
