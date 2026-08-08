import {
    CancellationToken,
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookEdit,
    NotebookRange,
    WorkspaceEdit,
    commands,
    l10n,
    notebooks,
    window,
    workspace
} from 'vscode';
import { injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { getBlockId, getEphemeralCellAgentSourceBlockId, isAgentCell } from './dataConversionUtils';

/** Same key as `agentBlockSchema` / `executeAgentBlock`. */
export const AGENT_MODEL_METADATA_KEY = 'deepnote_agent_model';

/** Persisted default — absent key becomes `undefined` and breaks openai() model selection. */
export const AGENT_MODEL_AUTO = 'auto';

const AGENT_MODEL_OPTIONS = [AGENT_MODEL_AUTO, 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

const CLEAR_EPHEMERAL_BLOCKS_COMMAND = 'deepnote.clearEphemeralBlocks';

const AGENT_INDICATOR_PRIORITY = 100;
const MODEL_PICKER_PRIORITY = 90;
const CLEAR_EPHEMERAL_PRIORITY = 80;

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
            commands.registerCommand(CLEAR_EPHEMERAL_BLOCKS_COMMAND, async (cell?: NotebookCell) => {
                if (!cell) {
                    throw new Error(`${CLEAR_EPHEMERAL_BLOCKS_COMMAND} requires the cell it was invoked from`);
                }

                await this.clearEphemeralBlocks(cell);
            })
        );

        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    /** Deletes the ephemeral cells this agent block generated, after a modal confirmation. */
    public async clearEphemeralBlocks(cell: NotebookCell): Promise<void> {
        if (!isAgentCell(cell)) {
            return;
        }

        const cellsToClear = this.getCellsToClear(cell);

        if (cellsToClear.length === 0) {
            return;
        }

        const confirmation = await window.showWarningMessage(
            l10n.t('Clear {0} ephemeral block(s) from this notebook?', cellsToClear.length),
            { modal: true },
            l10n.t('Clear')
        );

        if (confirmation !== l10n.t('Clear')) {
            return;
        }

        // Descending so each deletion's index still addresses the cell it was computed from.
        const deletions = [...cellsToClear]
            .sort((a, b) => b.index - a.index)
            .map((target) => NotebookEdit.deleteCells(new NotebookRange(target.index, target.index + 1)));

        const edit = new WorkspaceEdit();
        edit.set(cell.notebook.uri, deletions);

        if (!(await workspace.applyEdit(edit))) {
            void window.showErrorMessage(l10n.t('Failed to clear ephemeral blocks'));
        }
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

        const items = [this.createAgentIndicatorItem(), this.createModelPickerItem(cell, model)];

        if (this.getCellsToClear(cell).length > 0) {
            items.push(this.createClearEphemeralItem(cell));
        }

        return items;
    }

    private createAgentIndicatorItem(): NotebookCellStatusBarItem {
        return {
            text: `$(hubot) ${l10n.t('Agent Block')}`,
            alignment: 1,
            priority: AGENT_INDICATOR_PRIORITY,
            tooltip: l10n.t('Deepnote Agent Block\nAI-powered block that autonomously generates code and analysis')
        };
    }

    private createClearEphemeralItem(cell: NotebookCell): NotebookCellStatusBarItem {
        return {
            text: `$(trash) ${l10n.t('Clear ephemeral blocks')}`,
            alignment: 1,
            priority: CLEAR_EPHEMERAL_PRIORITY,
            tooltip: l10n.t('Remove the ephemeral blocks generated by this agent block'),
            command: {
                title: l10n.t('Clear ephemeral blocks'),
                command: CLEAR_EPHEMERAL_BLOCKS_COMMAND,
                arguments: [cell]
            }
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

    /** Ephemeral cells this agent block generated; empty when it has no block id or has not run. */
    private getCellsToClear(cell: NotebookCell): NotebookCell[] {
        const agentBlockId = getBlockId(cell);

        if (!agentBlockId) {
            return [];
        }

        return cell.notebook
            .getCells()
            .filter((candidate) => getEphemeralCellAgentSourceBlockId(candidate) === agentBlockId);
    }

    private getModel(metadata: Record<string, unknown> | undefined): string {
        const value = metadata?.[AGENT_MODEL_METADATA_KEY];
        if (typeof value === 'string' && value) {
            return value;
        }

        return AGENT_MODEL_AUTO;
    }

    public async switchModel(cell: NotebookCell): Promise<void> {
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
