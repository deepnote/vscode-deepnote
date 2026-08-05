import {
    CancellationToken,
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    l10n,
    notebooks,
    workspace
} from 'vscode';
import { injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { isEphemeralCell } from './dataConversionUtils';

const EPHEMERAL_INDICATOR_PRIORITY = 1000;

@injectable()
export class EphemeralCellStatusBarProvider
    implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService
{
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

        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    public provideCellStatusBarItems(
        cell: NotebookCell,
        token: CancellationToken
    ): NotebookCellStatusBarItem | undefined {
        if (token.isCancellationRequested) {
            return undefined;
        }

        if (!isEphemeralCell(cell)) {
            return undefined;
        }

        const agentSourceBlockId = cell.metadata?.agent_source_block_id as string | undefined;

        return this.createEphemeralIndicatorItem(agentSourceBlockId);
    }

    private createEphemeralIndicatorItem(agentSourceBlockId?: string): NotebookCellStatusBarItem {
        const tooltipLines = [l10n.t('Auto-generated ephemeral block')];
        if (agentSourceBlockId) {
            tooltipLines.push(l10n.t('Source agent block: {0}', agentSourceBlockId));
        }

        return {
            text: `$(sparkle) ${l10n.t('Ephemeral')}`,
            alignment: 1,
            priority: EPHEMERAL_INDICATOR_PRIORITY,
            tooltip: tooltipLines.join('\n')
        };
    }
}
