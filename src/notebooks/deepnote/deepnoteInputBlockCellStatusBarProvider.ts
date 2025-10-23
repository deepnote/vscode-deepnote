// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookEdit,
    Position,
    Range,
    WorkspaceEdit,
    commands,
    l10n,
    notebooks,
    window,
    workspace
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
    private readonly _onDidChangeCellStatusBarItems = new EventEmitter<void>();

    public readonly onDidChangeCellStatusBarItems = this._onDidChangeCellStatusBarItems.event;

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

        // Listen for notebook changes to update status bar
        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e) => {
                if (e.notebook.notebookType === 'deepnote') {
                    this._onDidChangeCellStatusBarItems.fire();
                }
            })
        );

        // Register command to update input block variable name
        this.disposables.push(
            commands.registerCommand('deepnote.updateInputBlockVariableName', async (cell?: NotebookCell) => {
                if (!cell) {
                    // Fall back to the active notebook cell
                    const activeEditor = window.activeNotebookEditor;
                    if (activeEditor && activeEditor.selection) {
                        cell = activeEditor.notebook.cellAt(activeEditor.selection.start);
                    }
                }

                if (!cell) {
                    void window.showErrorMessage(l10n.t('No active notebook cell'));
                    return;
                }

                await this.updateVariableName(cell);
            })
        );

        // Dispose our emitter with the extension
        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    provideCellStatusBarItems(cell: NotebookCell): NotebookCellStatusBarItem[] | undefined {
        // Check if this cell is a Deepnote input block
        // Get the block type from the __deepnotePocket metadata field
        const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;
        const blockType = pocket?.type;

        if (!blockType || !this.isInputBlock(blockType)) {
            return undefined;
        }

        const items: NotebookCellStatusBarItem[] = [];

        const formattedName = this.formatBlockTypeName(blockType);

        // Extract additional metadata for display
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const label = metadata?.deepnote_input_label as string | undefined;
        const buttonTitle = metadata?.deepnote_button_title as string | undefined;

        // Build status bar text with additional info
        let statusText = formattedName;
        if (label) {
            statusText += `: ${label}`;
        } else if (buttonTitle) {
            statusText += `: ${buttonTitle}`;
        }

        // Build detailed tooltip
        const tooltipLines = [`Deepnote ${formattedName}`];
        if (label) {
            tooltipLines.push(`Label: ${label}`);
        }
        if (buttonTitle) {
            tooltipLines.push(`Title: ${buttonTitle}`);
        }

        // Add type-specific metadata to tooltip
        this.addTypeSpecificTooltip(tooltipLines, blockType, metadata);

        // Create a status bar item showing the block type and metadata on the left
        items.push({
            text: statusText,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            priority: 100,
            tooltip: tooltipLines.join('\n')
        });

        // Add variable name status bar item (clickable)
        items.push(this.createVariableStatusBarItem(cell));

        return items;
    }

    /**
     * Adds type-specific metadata to the tooltip
     */
    private addTypeSpecificTooltip(
        tooltipLines: string[],
        blockType: string,
        metadata: Record<string, unknown> | undefined
    ): void {
        if (!metadata) {
            return;
        }

        switch (blockType) {
            case 'input-slider':
                const min = metadata.deepnote_slider_min_value;
                const max = metadata.deepnote_slider_max_value;
                const step = metadata.deepnote_slider_step;
                if (min !== undefined && max !== undefined) {
                    tooltipLines.push(`Range: ${min} - ${max}${step !== undefined ? ` (step: ${step})` : ''}`);
                }
                break;

            case 'input-select':
                const options = metadata.deepnote_variable_options as string[] | undefined;
                if (options && options.length > 0) {
                    tooltipLines.push(`Options: ${options.slice(0, 3).join(', ')}${options.length > 3 ? '...' : ''}`);
                }
                break;

            case 'input-file':
                const extensions = metadata.deepnote_allowed_file_extensions as string | undefined;
                if (extensions) {
                    tooltipLines.push(`Allowed extensions: ${extensions}`);
                }
                break;

            case 'button':
                const behavior = metadata.deepnote_button_behavior as string | undefined;
                const colorScheme = metadata.deepnote_button_color_scheme as string | undefined;
                if (behavior) {
                    tooltipLines.push(`Behavior: ${behavior}`);
                }
                if (colorScheme) {
                    tooltipLines.push(`Color: ${colorScheme}`);
                }
                break;
        }

        // Add default value if present
        const defaultValue = metadata.deepnote_variable_default_value;
        if (defaultValue !== undefined && defaultValue !== null) {
            tooltipLines.push(`Default: ${defaultValue}`);
        }
    }

    /**
     * Creates a status bar item for the variable name with a clickable command
     */
    private createVariableStatusBarItem(cell: NotebookCell): NotebookCellStatusBarItem {
        const variableName = this.getVariableName(cell);

        return {
            text: l10n.t('Variable: {0}', variableName),
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            priority: 90,
            tooltip: l10n.t('Variable name for input block\nClick to change'),
            command: {
                title: l10n.t('Change Variable Name'),
                command: 'deepnote.updateInputBlockVariableName',
                arguments: [cell]
            }
        };
    }

    /**
     * Gets the variable name from cell metadata or cell content
     */
    private getVariableName(cell: NotebookCell): string {
        const metadata = cell.metadata;
        if (metadata && typeof metadata === 'object') {
            const variableName = (metadata as Record<string, unknown>).deepnote_variable_name;
            if (typeof variableName === 'string' && variableName) {
                return variableName;
            }
        }

        // Fall back to cell content (which should contain the variable name)
        const cellContent = cell.document.getText().trim();
        if (cellContent) {
            return cellContent;
        }

        return '';
    }

    /**
     * Updates the variable name for an input block cell
     */
    private async updateVariableName(cell: NotebookCell): Promise<void> {
        const currentVariableName = this.getVariableName(cell);

        const newVariableNameInput = await window.showInputBox({
            prompt: l10n.t('Enter variable name for input block'),
            value: currentVariableName,
            ignoreFocusOut: true,
            validateInput: (value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                    return l10n.t('Variable name cannot be empty');
                }
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
                    return l10n.t('Variable name must be a valid Python identifier');
                }
                return undefined;
            }
        });

        const newVariableName = newVariableNameInput?.trim();
        if (newVariableName === undefined || newVariableName === currentVariableName) {
            return;
        }

        // Update both cell metadata and cell content
        const edit = new WorkspaceEdit();
        const updatedMetadata = {
            ...cell.metadata,
            deepnote_variable_name: newVariableName
        };

        // Update cell metadata
        edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

        // Update cell content (replace entire cell text with just the variable name)
        const fullRange = new Range(
            new Position(0, 0),
            new Position(cell.document.lineCount - 1, cell.document.lineAt(cell.document.lineCount - 1).text.length)
        );
        edit.replace(cell.document.uri, fullRange, newVariableName);

        const success = await workspace.applyEdit(edit);
        if (!success) {
            void window.showErrorMessage(l10n.t('Failed to update variable name'));
            return;
        }

        // Trigger status bar update
        this._onDidChangeCellStatusBarItems.fire();
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
