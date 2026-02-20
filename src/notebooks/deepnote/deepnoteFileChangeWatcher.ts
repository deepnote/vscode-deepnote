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
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { extractProjectIdFromSnapshotUri, isSnapshotFile } from './snapshots/snapshotFiles';
import { SnapshotService } from './snapshots/snapshotService';

const debounceTimeInMilliseconds = 500;
const snapshotSuppressionTimeInMilliseconds = 5000;

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
    private readonly converter = new DeepnoteDataConverter();
    private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly lastSnapshotFingerprints = new Map<string, string>();
    private readonly recentlySnapshotUpdatedUris = new Set<string>();
    private readonly suppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly serializer: DeepnoteNotebookSerializer;

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
        this.disposables.push(watcher.onDidCreate((uri) => this.handleFileChange(uri)));
        this.disposables.push({ dispose: () => this.clearAllTimers() });
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

    private clearAllTimers(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }

        this.debounceTimers.clear();

        for (const timer of this.suppressionTimers.values()) {
            clearTimeout(timer);
        }

        this.suppressionTimers.clear();
    }

    private getBlockIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
        return (metadata?.id ?? metadata?.__deepnoteBlockId) as string | undefined;
    }

    private handleFileChange(uri: Uri): void {
        if (isSnapshotFile(uri)) {
            this.handleSnapshotFileChange(uri);

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

    private handleSnapshotFileChange(uri: Uri): void {
        if (!this.snapshotService || !this.snapshotService.isSnapshotsEnabled()) {
            return;
        }

        if (this.snapshotService.wasRecentlyWritten(uri)) {
            return;
        }

        const projectId = extractProjectIdFromSnapshotUri(uri);

        if (!projectId) {
            return;
        }

        const key = `snapshot:${projectId}`;
        const existing = this.debounceTimers.get(key);

        if (existing) {
            clearTimeout(existing);
        }

        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);

                void this.reloadSnapshotOutputs(projectId);
            }, debounceTimeInMilliseconds)
        );
    }

    /**
     * After a `replaceCells` edit, VS Code does not reliably preserve cell
     * metadata.  This method reads the block IDs from the `cells` array that
     * was just applied and writes them back via `updateCellMetadata`, which
     * *does* persist.
     */
    private async restoreCellMetadata(notebook: NotebookDocument, cells: NotebookCellData[]): Promise<void> {
        const edits: ReturnType<typeof NotebookEdit.updateCellMetadata>[] = [];

        for (let i = 0; i < cells.length; i++) {
            const blockId = this.getBlockIdFromMetadata(cells[i].metadata);
            if (blockId) {
                edits.push(
                    NotebookEdit.updateCellMetadata(i, {
                        ...cells[i].metadata,
                        id: blockId,
                        __deepnoteBlockId: blockId
                    })
                );
            }
        }

        if (edits.length === 0) {
            return;
        }

        const metadataEdit = new WorkspaceEdit();
        metadataEdit.set(notebook.uri, edits);
        const applied = await workspace.applyEdit(metadataEdit);

        if (applied) {
            logger.info(`[FileChangeWatcher] Restored metadata for ${edits.length} cells: ${notebook.uri.path}`);
        } else {
            logger.warn(`[FileChangeWatcher] Failed to restore cell metadata: ${notebook.uri.path}`);
        }
    }

    private async reloadSnapshotOutputs(projectId: string): Promise<void> {
        if (!this.snapshotService) {
            return;
        }

        const affectedNotebooks = workspace.notebookDocuments.filter(
            (doc) => doc.notebookType === 'deepnote' && doc.metadata?.deepnoteProjectId === projectId
        );

        if (affectedNotebooks.length === 0) {
            return;
        }

        const snapshotOutputs = await this.snapshotService.readSnapshot(projectId);

        if (!snapshotOutputs || snapshotOutputs.size === 0) {
            return;
        }

        const fingerprint = JSON.stringify([...snapshotOutputs.entries()].sort(([a], [b]) => a.localeCompare(b)));

        if (this.lastSnapshotFingerprints.get(projectId) === fingerprint) {
            return;
        }

        this.lastSnapshotFingerprints.set(projectId, fingerprint);

        // Look up the original project blocks once so we can fall back to
        // positional block IDs when VS Code has lost cell metadata.
        const originalProject = this.notebookManager.getOriginalProject(projectId);
        const notebookBlocksMap = new Map<string, { id: string }[]>();
        if (originalProject) {
            for (const nb of originalProject.project.notebooks) {
                notebookBlocksMap.set(nb.id, nb.blocks);
            }
        }

        for (const notebook of affectedNotebooks) {
            try {
                const liveCells = notebook.getCells();
                const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;
                const originalBlocks = notebookId ? notebookBlocksMap.get(notebookId) : undefined;

                const newCells: NotebookCellData[] = liveCells.map((cell, index) => {
                    let blockId = this.getBlockIdFromMetadata(cell.metadata);

                    // Fall back to the original project blocks when VS Code has
                    // lost cell metadata (e.g. after a prior replaceCells).
                    if (!blockId && originalBlocks) {
                        blockId = originalBlocks[index]?.id;
                    }

                    const cellData = new NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);

                    cellData.metadata = { ...cell.metadata };

                    // Persist the (possibly fallback) block ID into the cell
                    // metadata so restoreCellMetadata can write it back after
                    // replaceCells inevitably strips it.
                    if (blockId) {
                        cellData.metadata.id = blockId;
                        cellData.metadata.__deepnoteBlockId = blockId;
                    }

                    if (blockId && snapshotOutputs.has(blockId)) {
                        const blockType = (cell.metadata?.type as string) ?? 'code';
                        cellData.outputs = this.converter.transformOutputsForVsCode(
                            snapshotOutputs.get(blockId)!,
                            index,
                            blockId,
                            blockType,
                            cell.metadata
                        );
                    } else {
                        cellData.outputs = [...cell.outputs];
                    }

                    return cellData;
                });

                const withOutputs = newCells.filter((c) => c.outputs && c.outputs.length > 0).length;
                const withBlockIds = newCells.filter((c) => this.getBlockIdFromMetadata(c.metadata)).length;
                logger.info(
                    `[FileChangeWatcher] Applying snapshot: ${newCells.length} cells, ` +
                        `${withOutputs} with outputs, ${withBlockIds} with block IDs`
                );

                const edit = new WorkspaceEdit();
                edit.set(notebook.uri, [NotebookEdit.replaceCells(new NotebookRange(0, notebook.cellCount), newCells)]);
                const applied = await workspace.applyEdit(edit);

                if (!applied) {
                    logger.warn(`[FileChangeWatcher] Failed to apply snapshot outputs: ${notebook.uri.path}`);
                    continue;
                }

                // Restore cell metadata that replaceCells may have stripped.
                await this.restoreCellMetadata(notebook, newCells);

                // Suppress main-file reloads triggered by the dirty state this
                // replaceCells creates.  The auto-save will write the main file
                // (outputs stripped), and the file-watcher would otherwise try to
                // reload the notebook from disk, losing the outputs we just set.
                const uriKey = notebook.uri.toString();
                this.recentlySnapshotUpdatedUris.add(uriKey);

                const existingSuppression = this.suppressionTimers.get(uriKey);
                if (existingSuppression) {
                    clearTimeout(existingSuppression);
                }

                this.suppressionTimers.set(
                    uriKey,
                    setTimeout(() => {
                        this.recentlySnapshotUpdatedUris.delete(uriKey);
                        this.suppressionTimers.delete(uriKey);
                    }, snapshotSuppressionTimeInMilliseconds)
                );

                logger.info(
                    `[FileChangeWatcher] Updated notebook outputs from external snapshot: ${notebook.uri.path}`
                );
            } catch (error) {
                logger.error(
                    `[FileChangeWatcher] Failed to update notebook from snapshot: ${notebook.uri.path}`,
                    error
                );
            }
        }
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

        // CancellationTokenSource is required by the deserializer API but
        // cancellation is not needed for file-change reloads.
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
            if (this.recentlySnapshotUpdatedUris.has(notebook.uri.toString())) {
                logger.info(
                    `[FileChangeWatcher] Skipping main-file reload for recently snapshot-updated notebook: ${notebook.uri.path}`
                );
                continue;
            }

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
                    const blockId = this.getBlockIdFromMetadata(liveCell.metadata);
                    if (blockId && liveCell.outputs.length > 0) {
                        liveOutputsByBlockId.set(blockId, liveCell.outputs);
                    }
                }

                for (const cell of newCells) {
                    const blockId = this.getBlockIdFromMetadata(cell.metadata);
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

                // Restore cell metadata that replaceCells may have stripped.
                await this.restoreCellMetadata(notebook, newCells);

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
