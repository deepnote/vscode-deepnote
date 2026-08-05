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

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { isAgentCell } from './dataConversionUtils';
import { clearOpenAiApiKey, promptForOpenAiApiKey } from './deepnoteSecretStore';

/** The key `agentBlockSchema` defines and `executeAgentBlock` reads. */
const AGENT_MODEL_METADATA_KEY = 'deepnote_agent_model';

/** Must be stored explicitly; a missing key becomes `undefined` in runtime-core and is passed to openai() as the model name. */
const AGENT_MODEL_AUTO = 'auto';

const AGENT_MODEL_OPTIONS = [AGENT_MODEL_AUTO, 'gpt-4o', 'gpt-5'];

const AGENT_INDICATOR_PRIORITY = 100;
const MODEL_PICKER_PRIORITY = 90;

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
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    public provideCellStatusBarItems(
        cell: NotebookCell,
        token: CancellationToken
    ): NotebookCellStatusBarItem[] | undefined {
        if (token.isCancellationRequested) {
            return undefined;
        }

        if (!isAgentCell(cell)) {
            return undefined;
        }

        const metadata = cell.metadata as Record<string, unknown> | undefined;
        const model = this.getModel(metadata);

        return [this.createAgentIndicatorItem(), this.createModelPickerItem(cell, model)];
    }

    private createAgentIndicatorItem(): NotebookCellStatusBarItem {
        return {
            text: `$(hubot) ${l10n.t('Agent Block')}`,
            alignment: 1,
            priority: AGENT_INDICATOR_PRIORITY,
            tooltip: l10n.t('Deepnote Agent Block\nAI-powered block that autonomously generates code and analysis')
        };
    }

    private createModelPickerItem(cell: NotebookCell, model: string): NotebookCellStatusBarItem {
        return {
            text: `$(symbol-enum) ${l10n.t('Model: {0}', model)}`,
            alignment: 1,
            priority: MODEL_PICKER_PRIORITY,
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

    private getModel(metadata: Record<string, unknown> | undefined): string {
        const value = metadata?.[AGENT_MODEL_METADATA_KEY];
        if (typeof value === 'string' && value) {
            return value;
        }

        return AGENT_MODEL_AUTO;
    }

    private async switchModel(cell: NotebookCell): Promise<void> {
        if (!isAgentCell(cell)) {
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

        await this.updateCellMetadata(cell, { [AGENT_MODEL_METADATA_KEY]: selected.label });
    }

    private async updateCellMetadata(cell: NotebookCell, updates: Record<string, unknown>): Promise<void> {
        const updatedMetadata = { ...cell.metadata, ...updates };

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
