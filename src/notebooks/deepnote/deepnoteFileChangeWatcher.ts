import {
    CancellationTokenSource,
    NotebookCellData,
    NotebookCellOutput,
    NotebookDocument,
    NotebookEdit,
    NotebookRange,
    Uri,
    WorkspaceEdit,
    workspace
} from 'vscode';
import { inject, injectable, optional } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { isSnapshotFile } from './snapshots/snapshotFiles';
import { SnapshotService } from './snapshots/snapshotService';

const debounceTimeInMilliseconds = 500;

/**
 * Watches .deepnote files for external changes and reloads open notebook editors.
 *
 * When AI agents (Cursor, Claude Code) modify a .deepnote file on disk,
 * VS Code's NotebookSerializer does not reliably detect and reload the notebook.
 * This service bridges that gap by watching the filesystem and applying edits
 * to open notebook documents when their underlying files change externally.
 */
@injectable()
export class DeepnoteFileChangeWatcher implements IExtensionSyncActivationService {
    private readonly serializer: DeepnoteNotebookSerializer;
    private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(SnapshotService) @optional() private readonly snapshotService?: SnapshotService
    ) {
        this.serializer = new DeepnoteNotebookSerializer(this.notebookManager, this.snapshotService);
    }

    public activate(): void {
        const watcher = workspace.createFileSystemWatcher('**/*.deepnote');

        this.disposables.push(watcher);
        this.disposables.push(watcher.onDidChange((uri) => this.handleFileChange(uri)));
        this.disposables.push({ dispose: () => this.clearAllTimers() });
    }

    private clearAllTimers(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }

        this.debounceTimers.clear();
    }

    private handleFileChange(uri: Uri): void {
        if (isSnapshotFile(uri)) {
            return;
        }

        const key = uri.toString();

        const existing = this.debounceTimers.get(key);

        if (existing) {
            clearTimeout(existing);
        }

        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);

                void this.reloadNotebooksForFile(uri);
            }, debounceTimeInMilliseconds)
        );
    }

    private cellsMatchNotebook(notebook: NotebookDocument, newCells: NotebookCellData[]): boolean {
        const liveCells = notebook.getCells();

        if (liveCells.length !== newCells.length) {
            return false;
        }

        return liveCells.every(
            (live, i) => live.document.getText() === newCells[i].value && live.kind === newCells[i].kind
        );
    }

    private async reloadNotebooksForFile(uri: Uri): Promise<void> {
        const uriString = uri.toString();

        const affectedNotebooks = workspace.notebookDocuments.filter(
            (doc) =>
                doc.notebookType === 'deepnote' && doc.uri.with({ query: '', fragment: '' }).toString() === uriString
        );

        if (affectedNotebooks.length === 0) {
            return;
        }

        let content: Uint8Array;

        try {
            content = await workspace.fs.readFile(uri);
        } catch (error) {
            logger.warn(`[FileChangeWatcher] Failed to read changed file: ${uri.path}`, error);
            return;
        }

        const tokenSource = new CancellationTokenSource();
        let newData;
        try {
            newData = await this.serializer.deserializeNotebook(content, tokenSource.token);
        } catch (error) {
            logger.warn(`[FileChangeWatcher] Failed to parse changed file: ${uri.path}`, error);
            return;
        } finally {
            tokenSource.dispose();
        }

        for (const notebook of affectedNotebooks) {
            try {
                const newCells = newData.cells.map((cell) => ({ ...cell }));

                if (this.cellsMatchNotebook(notebook, newCells)) {
                    continue;
                }

                // Preserve outputs from live cells that the deserialized data may lack.
                // In snapshot mode the main file has outputs stripped; AI agents
                // typically don't preserve outputs when editing code.
                const liveCells = notebook.getCells();
                const liveOutputsByBlockId = new Map<string, readonly NotebookCellOutput[]>();
                for (const liveCell of liveCells) {
                    const blockId = (liveCell.metadata?.id ?? liveCell.metadata?.__deepnoteBlockId) as
                        | string
                        | undefined;
                    if (blockId && liveCell.outputs.length > 0) {
                        liveOutputsByBlockId.set(blockId, liveCell.outputs);
                    }
                }

                for (const cell of newCells) {
                    const blockId = (cell.metadata?.id ?? cell.metadata?.__deepnoteBlockId) as string | undefined;
                    if (blockId && (!cell.outputs || cell.outputs.length === 0)) {
                        const liveOutputs = liveOutputsByBlockId.get(blockId);
                        if (liveOutputs) {
                            cell.outputs = [...liveOutputs];
                        }
                    }
                }

                const edit = new WorkspaceEdit();
                edit.set(notebook.uri, [NotebookEdit.replaceCells(new NotebookRange(0, notebook.cellCount), newCells)]);
                const applied = await workspace.applyEdit(edit);
                if (!applied) {
                    logger.warn(`[FileChangeWatcher] Failed to apply edit: ${notebook.uri.path}`);
                    continue;
                }

                // Save immediately so VS Code updates its internal mtime for the file.
                // Without this, the user gets a "content is newer" conflict dialog on
                // their next manual save because VS Code still remembers the old mtime.
                await workspace.save(notebook.uri);

                logger.info(`[FileChangeWatcher] Reloaded notebook from external change: ${notebook.uri.path}`);
            } catch (error) {
                logger.error(`[FileChangeWatcher] Failed to reload notebook: ${notebook.uri.path}`, error);
            }
        }
    }
}
