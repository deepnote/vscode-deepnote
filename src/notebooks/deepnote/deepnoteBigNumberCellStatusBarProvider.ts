// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    CancellationToken,
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookEdit,
    QuickPickItem,
    WorkspaceEdit,
    commands,
    l10n,
    notebooks,
    window,
    workspace
} from 'vscode';
import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IExtensionContext } from '../../platform/common/types';
import type { Pocket } from '../../platform/deepnote/pocket';
import { BigNumberComparisonSettingsWebviewProvider } from './bigNumberComparisonSettingsWebview';

/**
 * Provides status bar items for Deepnote big number block cells.
 */
@injectable()
export class DeepnoteBigNumberCellStatusBarProvider
    implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService
{
    private readonly disposables: Disposable[] = [];
    private readonly _onDidChangeCellStatusBarItems = new EventEmitter<void>();
    private readonly comparisonSettingsWebview: BigNumberComparisonSettingsWebviewProvider;

    public readonly onDidChangeCellStatusBarItems = this._onDidChangeCellStatusBarItems.event;

    constructor(@inject(IExtensionContext) extensionContext: IExtensionContext) {
        this.comparisonSettingsWebview = new BigNumberComparisonSettingsWebviewProvider(extensionContext);
    }

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

        // Register commands
        this.registerCommands();

        // Dispose our emitter with the extension
        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    private registerCommands(): void {
        // Command to update big number title
        this.disposables.push(
            commands.registerCommand('deepnote.updateBigNumberTitle', async (cell?: NotebookCell) => {
                if (!cell) {
                    const activeEditor = window.activeNotebookEditor;
                    if (activeEditor && activeEditor.selection) {
                        cell = activeEditor.notebook.cellAt(activeEditor.selection.start);
                    }
                }

                if (!cell) {
                    void window.showErrorMessage(l10n.t('No active notebook cell'));
                    return;
                }

                await this.updateTitle(cell);
            })
        );

        // Command to update big number format
        this.disposables.push(
            commands.registerCommand('deepnote.updateBigNumberFormat', async (cell?: NotebookCell) => {
                if (!cell) {
                    const activeEditor = window.activeNotebookEditor;
                    if (activeEditor && activeEditor.selection) {
                        cell = activeEditor.notebook.cellAt(activeEditor.selection.start);
                    }
                }

                if (!cell) {
                    void window.showErrorMessage(l10n.t('No active notebook cell'));
                    return;
                }

                await this.updateFormat(cell);
            })
        );

        // Command to configure comparison settings
        this.disposables.push(
            commands.registerCommand('deepnote.configureBigNumberComparison', async (cell?: NotebookCell) => {
                if (!cell) {
                    const activeEditor = window.activeNotebookEditor;
                    if (activeEditor && activeEditor.selection) {
                        cell = activeEditor.notebook.cellAt(activeEditor.selection.start);
                    }
                }

                if (!cell) {
                    void window.showErrorMessage(l10n.t('No active notebook cell'));
                    return;
                }

                await this.configureComparison(cell);
            })
        );
    }

    provideCellStatusBarItems(cell: NotebookCell, token: CancellationToken): NotebookCellStatusBarItem[] | undefined {
        if (token.isCancellationRequested) {
            return undefined;
        }

        // Check if this cell is a big number block
        const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;
        const blockType = pocket?.type;

        if (blockType?.toLowerCase() !== 'big-number') {
            return undefined;
        }

        const items: NotebookCellStatusBarItem[] = [];
        const metadata = cell.metadata as Record<string, unknown> | undefined;

        // 1. Block type indicator with title
        const title = (metadata?.deepnote_big_number_title as string) || '';
        const blockTypeText = title ? `Big Number: ${title}` : 'Big Number';
        items.push({
            text: blockTypeText,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            priority: 100,
            tooltip: this.buildTooltip(metadata)
        });

        // 2. Title editor
        const titleText = title ? `$(edit) ${title}` : '$(edit) Set title';
        items.push({
            text: titleText,
            alignment: 1,
            priority: 95,
            tooltip: l10n.t('Click to edit title'),
            command: {
                title: l10n.t('Edit Title'),
                command: 'deepnote.updateBigNumberTitle',
                arguments: [cell]
            }
        });

        // 3. Format selector
        const format = (metadata?.deepnote_big_number_format as string) || 'number';
        const formatIcon = this.getFormatIcon(format);
        const formatLabel = this.getFormatLabel(format);
        items.push({
            text: `${formatIcon} ${formatLabel}`,
            alignment: 1,
            priority: 90,
            tooltip: l10n.t('Click to change format'),
            command: {
                title: l10n.t('Change Format'),
                command: 'deepnote.updateBigNumberFormat',
                arguments: [cell]
            }
        });

        // 4. Comparison button
        const comparisonEnabled = (metadata?.deepnote_big_number_comparison_enabled as boolean) ?? false;
        const comparisonType = (metadata?.deepnote_big_number_comparison_type as string) || '';
        const comparisonValue = (metadata?.deepnote_big_number_comparison_value as string) || '';

        let comparisonText: string;
        if (comparisonEnabled && comparisonType && comparisonValue) {
            const comparisonTypeLabel = comparisonType === 'percentage-change' ? '% change' : 'vs';
            comparisonText = `$(graph) ${comparisonTypeLabel}: ${comparisonValue}`;
        } else {
            comparisonText = '$(graph) Add comparison';
        }

        items.push({
            text: comparisonText,
            alignment: 1,
            priority: 85,
            tooltip: l10n.t('Click to configure comparison'),
            command: {
                title: l10n.t('Configure Comparison'),
                command: 'deepnote.configureBigNumberComparison',
                arguments: [cell]
            }
        });

        return items;
    }

    private buildTooltip(metadata: Record<string, unknown> | undefined): string {
        const lines: string[] = ['Deepnote Big Number'];

        const title = metadata?.deepnote_big_number_title as string;
        if (title) {
            lines.push(l10n.t('Title: {0}', title));
        }

        const format = (metadata?.deepnote_big_number_format as string) || 'number';
        lines.push(l10n.t('Format: {0}', this.getFormatLabel(format)));

        const comparisonEnabled = (metadata?.deepnote_big_number_comparison_enabled as boolean) ?? false;
        if (comparisonEnabled) {
            lines.push(l10n.t('Comparison: Enabled'));
        }

        return lines.join('\n');
    }

    private getFormatIcon(format: string): string {
        switch (format) {
            case 'currency':
                return '$(symbol-currency)';
            case 'percent':
                return '$(symbol-misc)';
            default:
                return '$(symbol-number)';
        }
    }

    private getFormatLabel(format: string): string {
        switch (format) {
            case 'currency':
                return 'Currency';
            case 'percent':
                return 'Percent';
            case 'number':
            default:
                return 'Number';
        }
    }

    private async updateTitle(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentTitle = (metadata?.deepnote_big_number_title as string) || '';

        const newTitle = await window.showInputBox({
            prompt: l10n.t('Enter title for big number'),
            value: currentTitle,
            placeHolder: l10n.t('e.g., Total Revenue')
        });

        if (newTitle === undefined) {
            return;
        }

        await this.updateCellMetadata(cell, { deepnote_big_number_title: newTitle });
    }

    private async updateFormat(cell: NotebookCell): Promise<void> {
        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentFormat = (metadata?.deepnote_big_number_format as string) || 'number';

        const formatOptions: QuickPickItem[] = [
            { label: 'Number', description: 'Display as a number', picked: currentFormat === 'number' },
            { label: 'Currency', description: 'Display as currency', picked: currentFormat === 'currency' },
            { label: 'Percent', description: 'Display as percentage', picked: currentFormat === 'percent' }
        ];

        const selected = await window.showQuickPick(formatOptions, {
            placeHolder: l10n.t('Select format for big number')
        });

        if (!selected) {
            return;
        }

        const formatValue = selected.label.toLowerCase();
        await this.updateCellMetadata(cell, { deepnote_big_number_format: formatValue });
    }

    private async configureComparison(cell: NotebookCell): Promise<void> {
        const settings = await this.comparisonSettingsWebview.show(cell);
        if (settings) {
            this._onDidChangeCellStatusBarItems.fire();
        }
    }

    private async updateCellMetadata(cell: NotebookCell, updates: Record<string, unknown>): Promise<void> {
        const edit = new WorkspaceEdit();
        const updatedMetadata = {
            ...cell.metadata,
            ...updates
        };

        edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

        const success = await workspace.applyEdit(edit);
        if (!success) {
            void window.showErrorMessage(l10n.t('Failed to update big number settings'));
            return;
        }

        this._onDidChangeCellStatusBarItems.fire();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.comparisonSettingsWebview.dispose();
    }
}

