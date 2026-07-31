import {
    CancellationToken,
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookEdit,
    WorkspaceEdit,
    commands,
    l10n,
    notebooks,
    window,
    workspace
} from 'vscode';
import { injectable } from 'inversify';
import { z } from 'zod';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import type { Pocket } from '../../platform/deepnote/pocket';
import { logger } from '../../platform/logging';
import { clearOpenAiApiKey, promptForOpenAiApiKey } from './deepnoteSecretStore';

const DEFAULT_MAX_ITERATIONS = 20;
const MIN_ITERATIONS = 1;
const MAX_ITERATIONS = 100;
const AGENT_MODEL_OPTIONS = ['auto', 'gpt-4o', 'sonnet'];
const MaxIterationsSchema = z.coerce.number().int().min(MIN_ITERATIONS).max(MAX_ITERATIONS);

/**
 * Provides status bar items for agent cells showing the block type indicator,
 * AI model picker, and max iterations setting.
 */
@injectable()
export class AgentCellStatusBarProvider implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService {
    private readonly disposables: Disposable[] = [];
    private readonly _onDidChangeCellStatusBarItems = new EventEmitter<void>();

    public readonly onDidChangeCellStatusBarItems = this._onDidChangeCellStatusBarItems.event;

    public activate(): void {
        this.disposables.push(notebooks.registerNotebookCellStatusBarItemProvider('deepnote', this));

        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e) => {
                if (e.notebook.notebookType === 'deepnote') {
                    this._onDidChangeCellStatusBarItems.fire();
                }
            })
        );

        this.disposables.push(
            commands.registerCommand('deepnote.switchAgentModel', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.switchModel(activeCell);
                }
            })
        );

        this.disposables.push(
            commands.registerCommand('deepnote.setAgentMaxIterations', async (cell?: NotebookCell) => {
                const activeCell = cell || this.getActiveCell();
                if (activeCell) {
                    await this.setMaxIterations(activeCell);
                }
            })
        );

        this.disposables.push(
            commands.registerCommand('deepnote.setOpenAiApiKey', async () => {
                const key = await promptForOpenAiApiKey();
                if (key) {
                    void window.showInformationMessage(l10n.t('OpenAI API key has been saved.'));
                }
            })
        );

        this.disposables.push(
            commands.registerCommand('deepnote.clearOpenAiApiKey', async () => {
                await clearOpenAiApiKey();
                void window.showInformationMessage(l10n.t('OpenAI API key has been cleared.'));
            })
        );

        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    public provideCellStatusBarItems(
        cell: NotebookCell,
        token: CancellationToken
    ): NotebookCellStatusBarItem[] | undefined {
        if (token.isCancellationRequested) {
            return undefined;
        }

        if (!this.isAgentCell(cell)) {
            return undefined;
        }

        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const model = this.getModel(metadata);
        const maxIterations = this.getMaxIterations(metadata);

        return [
            this.createAgentIndicatorItem(),
            this.createModelPickerItem(cell, model),
            this.createMaxIterationsItem(cell, maxIterations)
        ];
    }

    private createAgentIndicatorItem(): NotebookCellStatusBarItem {
        return {
            text: `$(hubot) ${l10n.t('Agent Block')}`,
            alignment: 1,
            priority: 100,
            tooltip: l10n.t('Deepnote Agent Block\nAI-powered block that autonomously generates code and analysis')
        };
    }

    private createMaxIterationsItem(cell: NotebookCell, maxIterations: number): NotebookCellStatusBarItem {
        return {
            text: l10n.t('$(iterations) Max iterations: {0}', maxIterations),
            alignment: 1,
            priority: 80,
            tooltip: l10n.t('Maximum iterations for agent\nClick to change'),
            command: {
                title: l10n.t('Set Max Iterations'),
                command: 'deepnote.setAgentMaxIterations',
                arguments: [cell]
            }
        };
    }

    private createModelPickerItem(cell: NotebookCell, model: string): NotebookCellStatusBarItem {
        return {
            text: `$(symbol-enum) ${l10n.t('Model: {0}', model)}`,
            alignment: 1,
            priority: 90,
            tooltip: l10n.t('AI Model: {0}\nClick to change', model),
            command: {
                title: l10n.t('Switch Model'),
                command: 'deepnote.switchAgentModel',
                arguments: [cell]
            }
        };
    }

    private getActiveCell(): NotebookCell | undefined {
        const activeEditor = window.activeNotebookEditor;
        if (activeEditor && activeEditor.selection) {
            return activeEditor.notebook.cellAt(activeEditor.selection.start);
        }

        return undefined;
    }

    private getMaxIterations(metadata: Record<string, unknown> | undefined): number {
        const value = metadata?.deepnote_max_iterations;
        // z.coerce.number() turns true into 1, which then satisfies the range check, so booleans
        // would be accepted as an iteration count instead of falling back to the default.
        const result = typeof value === 'boolean' ? undefined : MaxIterationsSchema.safeParse(value);

        if (result?.success) {
            return result.data;
        }

        if (value !== undefined) {
            logger.debug(
                `getMaxIterations: invalid value ${JSON.stringify(value)}, using default ${DEFAULT_MAX_ITERATIONS}`
            );
        }

        return DEFAULT_MAX_ITERATIONS;
    }

    private getModel(metadata: Record<string, unknown> | undefined): string {
        const value = metadata?.deepnote_model;
        if (typeof value === 'string' && value) {
            return value;
        }

        return 'auto';
    }

    private isAgentCell(cell: NotebookCell): boolean {
        const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;

        return pocket?.type === 'agent';
    }

    private async setMaxIterations(cell: NotebookCell): Promise<void> {
        if (!this.isAgentCell(cell)) {
            return;
        }

        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentValue = this.getMaxIterations(metadata);

        const input = await window.showInputBox({
            prompt: l10n.t('Enter maximum number of iterations ({0}-{1})', MIN_ITERATIONS, MAX_ITERATIONS),
            value: String(currentValue),
            validateInput: (value) => {
                const num = parseInt(value, 10);
                if (isNaN(num) || !Number.isInteger(num)) {
                    return l10n.t('Please enter a whole number');
                }
                if (num < MIN_ITERATIONS || num > MAX_ITERATIONS) {
                    return l10n.t('Value must be between {0} and {1}', MIN_ITERATIONS, MAX_ITERATIONS);
                }

                return undefined;
            }
        });

        if (input === undefined) {
            return;
        }

        const newValue = parseInt(input, 10);
        if (newValue === currentValue) {
            return;
        }

        await this.updateCellMetadata(cell, { deepnote_max_iterations: newValue });
    }

    private async switchModel(cell: NotebookCell): Promise<void> {
        if (!this.isAgentCell(cell)) {
            return;
        }

        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const currentModel = this.getModel(metadata);

        const items = AGENT_MODEL_OPTIONS.map((option) => ({
            label: option,
            description: option === currentModel ? l10n.t('Currently selected') : undefined
        }));

        const selected = await window.showQuickPick(items, {
            placeHolder: l10n.t('Select AI model for agent')
        });

        if (!selected || selected.label === currentModel) {
            return;
        }

        const newModel = selected.label === 'auto' ? undefined : selected.label;

        await this.updateCellMetadata(cell, { deepnote_model: newModel });
    }

    private async updateCellMetadata(cell: NotebookCell, updates: Record<string, unknown>): Promise<void> {
        const updatedMetadata = { ...cell.metadata, ...updates };

        // Remove keys set to undefined so they don't persist
        for (const [key, value] of Object.entries(updates)) {
            if (value === undefined) {
                delete updatedMetadata[key];
            }
        }

        const edit = new WorkspaceEdit();
        edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

        const success = await workspace.applyEdit(edit);
        if (!success) {
            void window.showErrorMessage(l10n.t('Failed to update agent cell metadata'));
            return;
        }

        this._onDidChangeCellStatusBarItems.fire();
    }
}
