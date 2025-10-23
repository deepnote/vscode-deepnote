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

        // Register commands for type-specific actions
        this.registerTypeSpecificCommands();

        // Dispose our emitter with the extension
        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    private registerTypeSpecificCommands(): void {
        // Select input: choose option(s)
        this.disposables.push(
            commands.registerCommand('deepnote.selectInputChooseOption', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.selectInputChooseOption(activeCell);
                }
            })
        );

        // Slider: set min value
        this.disposables.push(
            commands.registerCommand('deepnote.sliderSetMin', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.sliderSetMin(activeCell);
                }
            })
        );

        // Slider: set max value
        this.disposables.push(
            commands.registerCommand('deepnote.sliderSetMax', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.sliderSetMax(activeCell);
                }
            })
        );

        // Checkbox: toggle value
        this.disposables.push(
            commands.registerCommand('deepnote.checkboxToggle', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.checkboxToggle(activeCell);
                }
            })
        );

        // Date input: choose date
        this.disposables.push(
            commands.registerCommand('deepnote.dateInputChooseDate', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.dateInputChooseDate(activeCell);
                }
            })
        );

        // Date range: choose start date
        this.disposables.push(
            commands.registerCommand('deepnote.dateRangeChooseStart', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.dateRangeChooseStart(activeCell);
                }
            })
        );

        // Date range: choose end date
        this.disposables.push(
            commands.registerCommand('deepnote.dateRangeChooseEnd', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.dateRangeChooseEnd(activeCell);
                }
            })
        );
    }

    private getActiveCell(): NotebookCell | undefined {
        const activeEditor = window.activeNotebookEditor;
        if (activeEditor && activeEditor.selection) {
            return activeEditor.notebook.cellAt(activeEditor.selection.start);
        }
        return undefined;
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

        // Add type-specific status bar items
        this.addTypeSpecificStatusBarItems(items, blockType, cell, metadata);

        return items;
    }

    /**
     * Adds type-specific status bar items based on the block type
     */
    private addTypeSpecificStatusBarItems(
        items: NotebookCellStatusBarItem[],
        blockType: string,
        cell: NotebookCell,
        metadata: Record<string, unknown> | undefined
    ): void {
        if (!metadata) {
            return;
        }

        switch (blockType) {
            case 'input-select':
                this.addSelectInputStatusBarItems(items, cell, metadata);
                break;

            case 'input-slider':
                this.addSliderInputStatusBarItems(items, cell, metadata);
                break;

            case 'input-checkbox':
                this.addCheckboxInputStatusBarItems(items, cell, metadata);
                break;

            case 'input-date':
                this.addDateInputStatusBarItems(items, cell, metadata);
                break;

            case 'input-date-range':
                this.addDateRangeInputStatusBarItems(items, cell, metadata);
                break;

            // input-text, input-textarea, input-file, and button don't have additional buttons
        }
    }

    private addSelectInputStatusBarItems(
        items: NotebookCellStatusBarItem[],
        cell: NotebookCell,
        metadata: Record<string, unknown>
    ): void {
        const selectType = metadata.deepnote_variable_select_type as string | undefined;
        const sourceVariable = metadata.deepnote_variable_selected_variable as string | undefined;
        const value = metadata.deepnote_variable_value;
        const allowMultiple = metadata.deepnote_allow_multiple_values as boolean | undefined;

        // Show current selection
        let selectionText = '';
        if (Array.isArray(value)) {
            selectionText = value.length > 0 ? value.join(', ') : l10n.t('None');
        } else if (typeof value === 'string') {
            selectionText = value || l10n.t('None');
        }

        items.push({
            text: l10n.t('Selection: {0}', selectionText),
            alignment: 1,
            priority: 80,
            tooltip: allowMultiple
                ? l10n.t('Current selection (multi-select)\nClick to change')
                : l10n.t('Current selection\nClick to change'),
            command: {
                title: l10n.t('Choose Option'),
                command: 'deepnote.selectInputChooseOption',
                arguments: [cell]
            }
        });

        // Show source variable if select type is from-variable
        if (selectType === 'from-variable' && sourceVariable) {
            items.push({
                text: l10n.t('Source: {0}', sourceVariable),
                alignment: 1,
                priority: 75,
                tooltip: l10n.t('Variable containing options')
            });
        }
    }

    private addSliderInputStatusBarItems(
        items: NotebookCellStatusBarItem[],
        cell: NotebookCell,
        metadata: Record<string, unknown>
    ): void {
        const min = metadata.deepnote_slider_min_value as number | undefined;
        const max = metadata.deepnote_slider_max_value as number | undefined;

        items.push({
            text: l10n.t('Min: {0}', min ?? 0),
            alignment: 1,
            priority: 80,
            tooltip: l10n.t('Minimum value\nClick to change'),
            command: {
                title: l10n.t('Set Min'),
                command: 'deepnote.sliderSetMin',
                arguments: [cell]
            }
        });

        items.push({
            text: l10n.t('Max: {0}', max ?? 10),
            alignment: 1,
            priority: 79,
            tooltip: l10n.t('Maximum value\nClick to change'),
            command: {
                title: l10n.t('Set Max'),
                command: 'deepnote.sliderSetMax',
                arguments: [cell]
            }
        });
    }

    private addCheckboxInputStatusBarItems(
        items: NotebookCellStatusBarItem[],
        cell: NotebookCell,
        metadata: Record<string, unknown>
    ): void {
        const value = metadata.deepnote_variable_value as boolean | undefined;
        const checked = value ?? false;

        items.push({
            text: checked ? l10n.t('$(check) Checked') : l10n.t('$(close) Unchecked'),
            alignment: 1,
            priority: 80,
            tooltip: l10n.t('Click to toggle'),
            command: {
                title: l10n.t('Toggle'),
                command: 'deepnote.checkboxToggle',
                arguments: [cell]
            }
        });
    }

    private addDateInputStatusBarItems(
        items: NotebookCellStatusBarItem[],
        cell: NotebookCell,
        metadata: Record<string, unknown>
    ): void {
        const value = metadata.deepnote_variable_value as string | undefined;
        const dateStr = value ? new Date(value).toLocaleDateString() : l10n.t('Not set');

        items.push({
            text: l10n.t('Date: {0}', dateStr),
            alignment: 1,
            priority: 80,
            tooltip: l10n.t('Click to choose date'),
            command: {
                title: l10n.t('Choose Date'),
                command: 'deepnote.dateInputChooseDate',
                arguments: [cell]
            }
        });
    }

    private addDateRangeInputStatusBarItems(
        items: NotebookCellStatusBarItem[],
        cell: NotebookCell,
        metadata: Record<string, unknown>
    ): void {
        const value = metadata.deepnote_variable_value;
        let startDate = l10n.t('Not set');
        let endDate = l10n.t('Not set');

        if (Array.isArray(value) && value.length === 2) {
            startDate = new Date(value[0]).toLocaleDateString();
            endDate = new Date(value[1]).toLocaleDateString();
        }

        items.push({
            text: l10n.t('Start: {0}', startDate),
            alignment: 1,
            priority: 80,
            tooltip: l10n.t('Click to choose start date'),
            command: {
                title: l10n.t('Choose Start Date'),
                command: 'deepnote.dateRangeChooseStart',
                arguments: [cell]
            }
        });

        items.push({
            text: l10n.t('End: {0}', endDate),
            alignment: 1,
            priority: 79,
            tooltip: l10n.t('Click to choose end date'),
            command: {
                title: l10n.t('Choose End Date'),
                command: 'deepnote.dateRangeChooseEnd',
                arguments: [cell]
            }
        });
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

        // Fall back to cell content (which should contain the variable name with "# " prefix)
        const cellContent = cell.document.getText().trim();
        if (cellContent) {
            // Remove "# " prefix if present
            return cellContent.startsWith('# ') ? cellContent.substring(2) : cellContent;
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

        // Update cell content (replace entire cell text with "# " + variable name)
        const fullRange = new Range(
            new Position(0, 0),
            new Position(cell.document.lineCount - 1, cell.document.lineAt(cell.document.lineCount - 1).text.length)
        );
        edit.replace(cell.document.uri, fullRange, `# ${newVariableName}`);

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

    /**
     * Handler for select input: choose option(s)
     */
    private async selectInputChooseOption(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        if (!metadata) {
            return;
        }

        const selectType = metadata.deepnote_variable_select_type as string | undefined;
        const allowMultiple = metadata.deepnote_allow_multiple_values as boolean | undefined;
        const currentValue = metadata.deepnote_variable_value;

        // Get options based on select type
        let options: string[] = [];
        if (selectType === 'from-variable') {
            // For from-variable type, we can't easily get the options here
            // Show a message to the user
            void window.showInformationMessage(
                l10n.t('This select input uses options from a variable. Edit the source variable to change options.')
            );
            return;
        } else {
            // from-options type
            const optionsArray = metadata.deepnote_variable_options as string[] | undefined;
            options = optionsArray || [];
        }

        if (options.length === 0) {
            void window.showWarningMessage(l10n.t('No options available'));
            return;
        }

        if (allowMultiple) {
            // Multi-select using QuickPick
            const currentSelection = Array.isArray(currentValue) ? currentValue : [];
            const selected = await window.showQuickPick(
                options.map((opt) => ({
                    label: opt,
                    picked: currentSelection.includes(opt)
                })),
                {
                    canPickMany: true,
                    placeHolder: l10n.t('Select one or more options')
                }
            );

            if (selected === undefined) {
                return;
            }

            const newValue = selected.map((item) => item.label);
            await this.updateCellMetadata(cell, { deepnote_variable_value: newValue });
        } else {
            // Single select
            const selected = await window.showQuickPick(options, {
                placeHolder: l10n.t('Select an option'),
                canPickMany: false
            });

            if (selected === undefined) {
                return;
            }

            await this.updateCellMetadata(cell, { deepnote_variable_value: selected });
        }
    }

    /**
     * Handler for slider: set min value
     */
    private async sliderSetMin(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentMin = (metadata?.deepnote_slider_min_value as number) ?? 0;

        const input = await window.showInputBox({
            prompt: l10n.t('Enter minimum value'),
            value: String(currentMin),
            validateInput: (value) => {
                const num = parseFloat(value);
                if (isNaN(num)) {
                    return l10n.t('Please enter a valid number');
                }
                return undefined;
            }
        });

        if (input === undefined) {
            return;
        }

        const newMin = parseFloat(input);
        await this.updateCellMetadata(cell, { deepnote_slider_min_value: newMin });
    }

    /**
     * Handler for slider: set max value
     */
    private async sliderSetMax(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentMax = (metadata?.deepnote_slider_max_value as number) ?? 10;

        const input = await window.showInputBox({
            prompt: l10n.t('Enter maximum value'),
            value: String(currentMax),
            validateInput: (value) => {
                const num = parseFloat(value);
                if (isNaN(num)) {
                    return l10n.t('Please enter a valid number');
                }
                return undefined;
            }
        });

        if (input === undefined) {
            return;
        }

        const newMax = parseFloat(input);
        await this.updateCellMetadata(cell, { deepnote_slider_max_value: newMax });
    }

    /**
     * Handler for checkbox: toggle value
     */
    private async checkboxToggle(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentValue = (metadata?.deepnote_variable_value as boolean) ?? false;

        await this.updateCellMetadata(cell, { deepnote_variable_value: !currentValue });
    }

    /**
     * Handler for date input: choose date
     */
    private async dateInputChooseDate(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentValue = metadata?.deepnote_variable_value as string | undefined;
        const currentDate = currentValue ? new Date(currentValue).toISOString().split('T')[0] : '';

        const input = await window.showInputBox({
            prompt: l10n.t('Enter date (YYYY-MM-DD)'),
            value: currentDate,
            validateInput: (value) => {
                if (!value) {
                    return l10n.t('Date cannot be empty');
                }
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    return l10n.t('Please enter date in YYYY-MM-DD format');
                }
                const date = new Date(value);
                if (isNaN(date.getTime())) {
                    return l10n.t('Invalid date');
                }
                return undefined;
            }
        });

        if (input === undefined) {
            return;
        }

        const newDate = new Date(input);
        await this.updateCellMetadata(cell, { deepnote_variable_value: newDate.toISOString() });
    }

    /**
     * Handler for date range: choose start date
     */
    private async dateRangeChooseStart(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentValue = metadata?.deepnote_variable_value;
        let currentStart = '';
        let currentEnd = '';

        if (Array.isArray(currentValue) && currentValue.length === 2) {
            currentStart = new Date(currentValue[0]).toISOString().split('T')[0];
            currentEnd = new Date(currentValue[1]).toISOString().split('T')[0];
        }

        const input = await window.showInputBox({
            prompt: l10n.t('Enter start date (YYYY-MM-DD)'),
            value: currentStart,
            validateInput: (value) => {
                if (!value) {
                    return l10n.t('Date cannot be empty');
                }
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    return l10n.t('Please enter date in YYYY-MM-DD format');
                }
                const date = new Date(value);
                if (isNaN(date.getTime())) {
                    return l10n.t('Invalid date');
                }
                return undefined;
            }
        });

        if (input === undefined) {
            return;
        }

        const newStart = new Date(input).toISOString();
        const newValue = currentEnd ? [newStart, new Date(currentEnd).toISOString()] : [newStart, newStart];
        await this.updateCellMetadata(cell, { deepnote_variable_value: newValue });
    }

    /**
     * Handler for date range: choose end date
     */
    private async dateRangeChooseEnd(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentValue = metadata?.deepnote_variable_value;
        let currentStart = '';
        let currentEnd = '';

        if (Array.isArray(currentValue) && currentValue.length === 2) {
            currentStart = new Date(currentValue[0]).toISOString().split('T')[0];
            currentEnd = new Date(currentValue[1]).toISOString().split('T')[0];
        }

        const input = await window.showInputBox({
            prompt: l10n.t('Enter end date (YYYY-MM-DD)'),
            value: currentEnd,
            validateInput: (value) => {
                if (!value) {
                    return l10n.t('Date cannot be empty');
                }
                if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    return l10n.t('Please enter date in YYYY-MM-DD format');
                }
                const date = new Date(value);
                if (isNaN(date.getTime())) {
                    return l10n.t('Invalid date');
                }
                return undefined;
            }
        });

        if (input === undefined) {
            return;
        }

        const newEnd = new Date(input).toISOString();
        const newValue = currentStart ? [new Date(currentStart).toISOString(), newEnd] : [newEnd, newEnd];
        await this.updateCellMetadata(cell, { deepnote_variable_value: newValue });
    }

    /**
     * Helper method to update cell metadata
     */
    private async updateCellMetadata(cell: NotebookCell, updates: Record<string, unknown>): Promise<void> {
        const edit = new WorkspaceEdit();
        const updatedMetadata = {
            ...cell.metadata,
            ...updates
        };

        edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

        const success = await workspace.applyEdit(edit);
        if (!success) {
            void window.showErrorMessage(l10n.t('Failed to update cell metadata'));
            return;
        }

        // Trigger status bar update
        this._onDidChangeCellStatusBarItems.fire();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
