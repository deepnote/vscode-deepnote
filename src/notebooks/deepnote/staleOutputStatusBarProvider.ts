import {
    CancellationToken,
    EventEmitter,
    NotebookCell,
    NotebookCellKind,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookDocumentChangeEvent,
    NotebookEdit,
    ProviderResult,
    WorkspaceEdit,
    l10n,
    notebooks,
    workspace
} from 'vscode';
import { inject, injectable, optional } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { computeHash } from '../../platform/common/crypto';
import { IDisposableRegistry } from '../../platform/common/types';
import { Pocket } from '../../platform/deepnote/pocket';
import { notebookCellExecutions, NotebookCellExecutionState } from '../../platform/notebooks/cellExecutionStateService';
import { SnapshotService } from './snapshots/snapshotService';

/**
 * Provides status bar items for cells with stale outputs.
 * An output is considered stale when the cell content has changed since the output was generated.
 */
@injectable()
export class StaleOutputStatusBarProvider
    implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService
{
    private readonly _onDidChangeCellStatusBarItems = new EventEmitter<void>();

    public readonly onDidChangeCellStatusBarItems = this._onDidChangeCellStatusBarItems.event;

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(SnapshotService) @optional() private readonly snapshotService?: SnapshotService
    ) {}

    public activate(): void {
        this.disposables.push(notebooks.registerNotebookCellStatusBarItemProvider('deepnote', this));

        // Refresh when any Deepnote notebook changes (e.g., cell content edited)
        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e: NotebookDocumentChangeEvent) => {
                if (e.notebook.notebookType === 'deepnote') {
                    this._onDidChangeCellStatusBarItems.fire();
                }
            })
        );

        // Listen for cell execution completion to update contentHash
        this.disposables.push(
            notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                if (e.cell.notebook.notebookType === 'deepnote' && e.state === NotebookCellExecutionState.Idle) {
                    void this.handleCellExecutionComplete(e.cell);
                }
            })
        );

        this.disposables.push(this._onDidChangeCellStatusBarItems);
    }

    public provideCellStatusBarItems(
        cell: NotebookCell,
        token: CancellationToken
    ): ProviderResult<NotebookCellStatusBarItem | NotebookCellStatusBarItem[]> {
        if (token?.isCancellationRequested) {
            return;
        }

        if (cell.kind !== NotebookCellKind.Code) {
            return;
        }

        if (cell.outputs.length === 0) {
            return;
        }

        const storedHash = this.getStoredExecutionHash(cell);

        // If no hash exists, the cell was never executed (by us), don't show indicator
        if (!storedHash) {
            return;
        }

        return this.checkAndCreateStatusBarItem(cell, storedHash);
    }

    private async checkAndCreateStatusBarItem(
        cell: NotebookCell,
        storedHash: string
    ): Promise<NotebookCellStatusBarItem | undefined> {
        const currentContent = cell.document.getText();
        const currentHash = `sha256:${await computeHash(currentContent, 'SHA-256')}`;

        const cellKey = this.getCellKey(cell);
        const cachedExecutedHash = this.executedContentHashes.get(cellKey);

        if (cachedExecutedHash && cachedExecutedHash === currentHash) {
            return;
        }

        if (currentHash === storedHash) {
            return;
        }

        return {
            text: `$(warning) ${l10n.t('Output may be stale')}`,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            priority: 85,
            tooltip: l10n.t(
                'Cell content has changed since outputs were generated.\nRe-run the cell to update outputs.'
            ),
            command: {
                title: l10n.t('Re-run cell'),
                command: 'notebook.cell.execute',
                arguments: [{ ranges: [{ start: cell.index, end: cell.index + 1 }], document: cell.notebook.uri }]
            }
        };
    }

    /**
     * In-memory cache of content hashes at the time of execution.
     * This provides immediate access to the hash without waiting for metadata persistence.
     * Key format: cell document URI string
     */
    private readonly executedContentHashes = new Map<string, string>();

    private getCellKey(cell: NotebookCell): string {
        return cell.document.uri.toString();
    }

    private getStoredExecutionHash(cell: NotebookCell): string | undefined {
        const inMemoryHash = this.executedContentHashes.get(this.getCellKey(cell));

        if (inMemoryHash) {
            return inMemoryHash;
        }

        const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;

        return pocket?.contentHash;
    }

    /**
     * Updates the cell's contentHash when execution completes successfully.
     * This ensures the stale indicator is removed after re-running a cell.
     */
    private async handleCellExecutionComplete(cell: NotebookCell): Promise<void> {
        if (cell.kind !== NotebookCellKind.Code) {
            return;
        }

        if (cell.executionSummary?.success === false) {
            return;
        }

        try {
            const content = cell.document.getText();
            const hash = await computeHash(content, 'SHA-256');
            const newContentHash = `sha256:${hash}`;

            const cellKey = this.getCellKey(cell);

            this.executedContentHashes.set(cellKey, newContentHash);
            this._onDidChangeCellStatusBarItems.fire();

            // In snapshot mode we avoid mutating cell metadata to prevent dirty state.
            if (this.snapshotService?.isSnapshotsEnabled()) {
                return;
            }

            // Also persist the hash to cell metadata for cross-session persistence
            const existingPocket = (cell.metadata?.__deepnotePocket as Record<string, unknown>) || {};
            if (existingPocket.contentHash === newContentHash) {
                return;
            }

            const updatedPocket = { ...existingPocket, contentHash: newContentHash };

            const edit = new WorkspaceEdit();
            const updatedMetadata = {
                ...cell.metadata,
                __deepnotePocket: updatedPocket
            };

            edit.set(cell.notebook.uri, [NotebookEdit.updateCellMetadata(cell.index, updatedMetadata)]);

            await workspace.applyEdit(edit);
        } catch {
            // Silently ignore errors - the stale indicator will just remain
        }
    }
}
