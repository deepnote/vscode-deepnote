import {
    CancellationToken,
    EventEmitter,
    NotebookCell,
    NotebookCellKind,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarItemProvider,
    NotebookDocument,
    NotebookDocumentChangeEvent,
    ProviderResult,
    l10n,
    notebooks,
    workspace
} from 'vscode';
import { inject, injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { computeHash } from '../../platform/common/crypto';
import { IDisposableRegistry } from '../../platform/common/types';
import { Pocket } from '../../platform/deepnote/pocket';
import { notebookCellExecutions, NotebookCellExecutionState } from '../../platform/notebooks/cellExecutionStateService';
import { INPUT_BLOCK_TYPES } from './deepnoteNotebookCommandListener';

/**
 * Provides status bar items for input blocks with stale values.
 * An input block is considered stale when its content has changed since it was last run.
 */
@injectable()
export class DirtyInputBlockStatusBarProvider
    implements NotebookCellStatusBarItemProvider, IExtensionSyncActivationService
{
    private readonly _onDidChangeCellStatusBarItems = new EventEmitter<void>();

    public readonly onDidChangeCellStatusBarItems = this._onDidChangeCellStatusBarItems.event;

    /**
     * In-memory cache of content hashes at the time of cell execution.
     * Key format: cell document URI string
     * Value: SHA-256 hash of the cell content when last run
     */
    private readonly executedContentHashes = new Map<string, string>();

    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {}

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

        // When a notebook is opened, capture the initial content hashes for input blocks
        this.disposables.push(
            workspace.onDidOpenNotebookDocument((notebook: NotebookDocument) => {
                if (notebook.notebookType === 'deepnote') {
                    void this.captureInitialHashes(notebook);
                }
            })
        );

        // When a cell execution completes, update the hash for that cell
        this.disposables.push(
            notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                if (e.cell.notebook.notebookType === 'deepnote' && e.state === NotebookCellExecutionState.Idle) {
                    void this.handleCellExecutionComplete(e.cell);
                }
            })
        );

        // When a notebook is closed, clean up the cached hashes
        this.disposables.push(
            workspace.onDidCloseNotebookDocument((notebook: NotebookDocument) => {
                if (notebook.notebookType === 'deepnote') {
                    this.cleanupHashes(notebook);
                }
            })
        );

        // Capture hashes for any already-open notebooks
        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType === 'deepnote') {
                void this.captureInitialHashes(notebook);
            }
        }

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

        if (!this.isInputBlock(cell)) {
            return;
        }

        return this.checkAndCreateStatusBarItem(cell);
    }

    private isInputBlock(cell: NotebookCell): boolean {
        const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;
        const blockType = pocket?.type;

        return blockType !== undefined && INPUT_BLOCK_TYPES.includes(blockType.toLowerCase() as never);
    }

    private getCellKey(cell: NotebookCell): string {
        return cell.document.uri.toString();
    }

    private async captureInitialHashes(notebook: NotebookDocument): Promise<void> {
        for (const cell of notebook.getCells()) {
            if (cell.kind === NotebookCellKind.Code && this.isInputBlock(cell)) {
                const cellKey = this.getCellKey(cell);

                // Only capture if we don't already have a hash for this cell
                if (!this.executedContentHashes.has(cellKey)) {
                    const content = cell.document.getText();
                    const hash = `sha256:${await computeHash(content, 'SHA-256')}`;
                    this.executedContentHashes.set(cellKey, hash);
                }
            }
        }
    }

    private async handleCellExecutionComplete(cell: NotebookCell): Promise<void> {
        if (cell.kind !== NotebookCellKind.Code || !this.isInputBlock(cell)) {
            return;
        }

        const cellKey = this.getCellKey(cell);
        const content = cell.document.getText();
        const hash = `sha256:${await computeHash(content, 'SHA-256')}`;
        this.executedContentHashes.set(cellKey, hash);

        this._onDidChangeCellStatusBarItems.fire();
    }

    private cleanupHashes(notebook: NotebookDocument): void {
        const notebookUriString = notebook.uri.toString();

        for (const key of this.executedContentHashes.keys()) {
            if (key.startsWith(notebookUriString)) {
                this.executedContentHashes.delete(key);
            }
        }
    }

    private async checkAndCreateStatusBarItem(cell: NotebookCell): Promise<NotebookCellStatusBarItem | undefined> {
        const cellKey = this.getCellKey(cell);
        const executedHash = this.executedContentHashes.get(cellKey);

        // If no executed hash exists, capture it now (this can happen if cell was added after notebook opened)
        if (!executedHash) {
            const content = cell.document.getText();
            const hash = `sha256:${await computeHash(content, 'SHA-256')}`;
            this.executedContentHashes.set(cellKey, hash);

            return;
        }

        const currentContent = cell.document.getText();
        const currentHash = `sha256:${await computeHash(currentContent, 'SHA-256')}`;

        if (currentHash === executedHash) {
            return;
        }

        return {
            text: `$(warning) ${l10n.t('Stale input')}`,
            alignment: 1, // NotebookCellStatusBarAlignment.Left
            priority: 85,
            tooltip: l10n.t('Input value has changed since last run.\nRe-run the cell to apply the new value.'),
            command: {
                title: l10n.t('Re-run cell'),
                command: 'notebook.cell.execute',
                arguments: [{ ranges: [{ start: cell.index, end: cell.index + 1 }], document: cell.notebook.uri }]
            }
        };
    }
}
