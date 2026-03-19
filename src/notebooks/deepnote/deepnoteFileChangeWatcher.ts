import {
    CancellationTokenSource,
    NotebookCell,
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
import type { DeepnoteBlock } from '@deepnote/blocks';

import { IControllerRegistration } from '../controllers/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import { extractProjectIdFromSnapshotUri, isSnapshotFile } from './snapshots/snapshotFiles';
import { SnapshotService } from './snapshots/snapshotService';

const debounceTimeInMilliseconds = 500;

/** Stale self-write entries are cleaned up after this duration (leak prevention). */
const selfWriteExpirationMs = 30_000;

/**
 * Operation types for the per-notebook queue.
 * main-file-sync always supersedes snapshot-output-update.
 */
type OperationType = 'main-file-sync' | 'snapshot-output-update';

interface PendingOperation {
    type: OperationType;
    /** For snapshot-output-update: the project ID to read outputs from. */
    projectId?: string;
}

/**
 * Watches .deepnote files for external changes and reloads open notebook editors.
 *
 * When AI agents (Cursor, Claude Code) modify a .deepnote file on disk,
 * VS Code's NotebookSerializer does not reliably detect and reload the notebook.
 * This service bridges that gap by watching the filesystem and applying edits
 * to open notebook documents when their underlying files change externally.
 *
 * Key design principles:
 * - Deterministic self-write detection (no timers)
 * - Content-based auto-save detection (source comparison)
 * - Atomic edits (replaceCells + metadata in single WorkspaceEdit)
 * - Per-cell snapshot output updates
 * - Serialized operation queue with coalescing
 */
@injectable()
export class DeepnoteFileChangeWatcher implements IExtensionSyncActivationService {
    private readonly converter = new DeepnoteDataConverter();
    private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Per-notebook operation queue. Only one operation runs at a time per notebook.
     * Pending operations are coalesced: main-file-sync supersedes everything.
     */
    private readonly pendingOperations = new Map<string, PendingOperation>();
    private readonly runningOperations = new Set<string>();

    /**
     * Deterministic self-write tracking for workspace.save() calls.
     * Incremented before save, decremented when the fs event arrives.
     */
    private readonly selfWriteCounts = new Map<string, number>();
    private readonly selfWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly serializer: DeepnoteNotebookSerializer;

    /**
     * Deterministic self-write tracking for snapshot file writes.
     * Populated via SnapshotService.onFileWritten callback.
     */
    private readonly snapshotSelfWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly snapshotSelfWriteUris = new Set<string>();

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(SnapshotService) @optional() private readonly snapshotService?: SnapshotService,
        @inject(IControllerRegistration) @optional() private readonly controllerRegistration?: IControllerRegistration
    ) {
        this.serializer = new DeepnoteNotebookSerializer(this.notebookManager, this.snapshotService);
    }

    public activate(): void {
        const watcher = workspace.createFileSystemWatcher('**/*.deepnote');

        this.disposables.push(watcher);
        this.disposables.push(watcher.onDidChange((uri) => this.handleFileChange(uri)));
        this.disposables.push(watcher.onDidCreate((uri) => this.handleFileChange(uri)));
        this.disposables.push({ dispose: () => this.clearAllTimers() });

        if (this.snapshotService) {
            this.disposables.push(
                this.snapshotService.onFileWritten((uri) => {
                    const key = uri.toString();
                    this.snapshotSelfWriteUris.add(key);

                    // Safety net: clean stale entries after 30s
                    const existing = this.snapshotSelfWriteTimers.get(key);
                    if (existing) {
                        clearTimeout(existing);
                    }
                    this.snapshotSelfWriteTimers.set(
                        key,
                        setTimeout(() => {
                            this.snapshotSelfWriteUris.delete(key);
                            this.snapshotSelfWriteTimers.delete(key);
                        }, selfWriteExpirationMs)
                    );
                })
            );
        }
    }

    private clearAllTimers(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        for (const timer of this.selfWriteTimers.values()) {
            clearTimeout(timer);
        }
        this.selfWriteTimers.clear();
        this.selfWriteCounts.clear();

        for (const timer of this.snapshotSelfWriteTimers.values()) {
            clearTimeout(timer);
        }
        this.snapshotSelfWriteTimers.clear();
        this.snapshotSelfWriteUris.clear();
    }

    /**
     * Consumes a self-write marker. Returns true if the fs event was self-triggered.
     */
    private consumeSelfWrite(uri: Uri): boolean {
        const key = this.normalizeFileUri(uri);

        // Check snapshot self-writes first
        if (this.snapshotSelfWriteUris.has(key)) {
            this.snapshotSelfWriteUris.delete(key);
            const timer = this.snapshotSelfWriteTimers.get(key);
            if (timer) {
                clearTimeout(timer);
                this.snapshotSelfWriteTimers.delete(key);
            }
            return true;
        }

        // Check workspace.save self-writes
        const count = this.selfWriteCounts.get(key);
        if (count && count > 0) {
            if (count === 1) {
                this.selfWriteCounts.delete(key);
                const timer = this.selfWriteTimers.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.selfWriteTimers.delete(key);
                }
            } else {
                this.selfWriteCounts.set(key, count - 1);
            }
            return true;
        }

        return false;
    }

    /**
     * Checks whether the source code content has actually changed between the
     * live notebook and the new cells from disk. If only outputs differ (disk
     * has fewer/no outputs), it's an auto-save of stripped content — skip reload.
     */
    private contentActuallyChanged(notebook: NotebookDocument, newCells: NotebookCellData[]): boolean {
        const liveCells = notebook.getCells();
        if (liveCells.length !== newCells.length) {
            return true;
        }

        return liveCells.some(
            (live, i) =>
                live.kind !== newCells[i].kind ||
                live.document.languageId !== newCells[i].languageId ||
                live.document.getText() !== newCells[i].value
        );
    }

    /**
     * Drains the operation queue for a given notebook URI.
     * Only one operation runs at a time per notebook.
     */
    private async drainQueue(nbKey: string, notebook: NotebookDocument, fileUri?: Uri): Promise<void> {
        if (this.runningOperations.has(nbKey)) {
            return; // Another operation is running; it will pick up the pending one when done
        }

        while (this.pendingOperations.has(nbKey)) {
            const op = this.pendingOperations.get(nbKey)!;
            this.pendingOperations.delete(nbKey);
            this.runningOperations.add(nbKey);

            try {
                if (op.type === 'main-file-sync') {
                    await this.executeMainFileSync(notebook, fileUri ?? notebook.uri.with({ query: '', fragment: '' }));
                } else if (op.type === 'snapshot-output-update' && op.projectId) {
                    await this.executeSnapshotOutputUpdate(notebook, op.projectId);
                }
            } catch (error) {
                logger.error(`[FileChangeWatcher] Operation ${op.type} failed for ${nbKey}`, error);
            } finally {
                this.runningOperations.delete(nbKey);
            }
        }
    }

    /**
     * Enqueue a main-file-sync operation for all notebooks matching this URI.
     * Main-file-sync always supersedes any pending operation.
     */
    private enqueueMainFileSync(uri: Uri): void {
        const uriString = uri.toString();
        const affectedNotebooks = workspace.notebookDocuments.filter(
            (doc) =>
                doc.notebookType === 'deepnote' && doc.uri.with({ query: '', fragment: '' }).toString() === uriString
        );

        for (const notebook of affectedNotebooks) {
            const nbKey = notebook.uri.toString();
            // main-file-sync always replaces any pending operation
            this.pendingOperations.set(nbKey, { type: 'main-file-sync' });
            void this.drainQueue(nbKey, notebook, uri);
        }
    }

    /**
     * Enqueue a snapshot-output-update for all notebooks matching this project.
     * Does NOT replace a pending main-file-sync.
     */
    private enqueueSnapshotOutputUpdate(projectId: string): void {
        const affectedNotebooks = workspace.notebookDocuments.filter(
            (doc) => doc.notebookType === 'deepnote' && doc.metadata?.deepnoteProjectId === projectId
        );

        for (const notebook of affectedNotebooks) {
            const nbKey = notebook.uri.toString();
            const pending = this.pendingOperations.get(nbKey);
            // Don't replace a pending main-file-sync
            if (pending?.type === 'main-file-sync') {
                continue;
            }
            this.pendingOperations.set(nbKey, { type: 'snapshot-output-update', projectId });
            void this.drainQueue(nbKey, notebook);
        }
    }

    /**
     * Execute a main-file-sync: read file, deserialize, apply atomic edit.
     */
    private async executeMainFileSync(notebook: NotebookDocument, fileUri: Uri): Promise<void> {
        let content: Uint8Array;
        try {
            content = await workspace.fs.readFile(fileUri);
        } catch (error) {
            logger.warn(`[FileChangeWatcher] Failed to read changed file: ${fileUri.path}`, error);
            return;
        }

        const tokenSource = new CancellationTokenSource();
        let newData;
        try {
            newData = await this.serializer.deserializeNotebook(content, tokenSource.token);
        } catch (error) {
            logger.warn(`[FileChangeWatcher] Failed to parse changed file: ${fileUri.path}`, error);
            return;
        } finally {
            tokenSource.dispose();
        }

        const newCells = newData.cells.map((cell) => ({ ...cell }));

        // Content-based detection: if source code hasn't changed, this is
        // just an auto-save of stripped outputs. Skip the reload.
        if (!this.contentActuallyChanged(notebook, newCells)) {
            logger.info(`[FileChangeWatcher] Source unchanged, skipping reload: ${notebook.uri.path}`);
            return;
        }

        // Preserve live outputs for matching blocks (main file has outputs stripped in snapshot mode)
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

        // Atomic edit: replaceCells + metadata restores in a single WorkspaceEdit
        const edits: NotebookEdit[] = [];
        edits.push(NotebookEdit.replaceCells(new NotebookRange(0, notebook.cellCount), newCells));

        for (let i = 0; i < newCells.length; i++) {
            const blockId = this.getBlockIdFromMetadata(newCells[i].metadata);
            if (blockId) {
                edits.push(
                    NotebookEdit.updateCellMetadata(i, {
                        ...newCells[i].metadata,
                        id: blockId,
                        __deepnoteBlockId: blockId
                    })
                );
            }
        }

        // Apply the edit to update in-memory cells immediately (responsive UX).
        const wsEdit = new WorkspaceEdit();
        wsEdit.set(notebook.uri, edits);
        const applied = await workspace.applyEdit(wsEdit);

        if (!applied) {
            logger.warn(`[FileChangeWatcher] Failed to apply edit: ${notebook.uri.path}`);
            return;
        }

        // Serialize the notebook and write canonical bytes to disk. This ensures
        // the file on disk matches what VS Code's serializer would produce.
        // Then save via workspace.save() to clear dirty state and update VS Code's
        // internal mtime tracker. Since WE just wrote the file, its mtime is from
        // our write (not the external change), avoiding the "content is newer" conflict.
        const serializeTokenSource = new CancellationTokenSource();
        try {
            const serializedBytes = await this.serializer.serializeNotebook(newData, serializeTokenSource.token);

            // Write to disk first — this updates the file mtime to "now"
            this.markSelfWrite(fileUri);
            try {
                await workspace.fs.writeFile(fileUri, serializedBytes);
            } catch (writeError) {
                this.consumeSelfWrite(fileUri);
                logger.warn(`[FileChangeWatcher] Failed to write synced file: ${fileUri.path}`, writeError);
            }

            // Now save — VS Code serializes (same bytes), sees the mtime is from our
            // recent write (which its internal watcher has picked up), and writes
            // successfully without a "content is newer" conflict.
            this.markSelfWrite(fileUri);
            try {
                await workspace.save(notebook.uri);
            } catch (saveError) {
                this.consumeSelfWrite(fileUri);
                logger.warn(`[FileChangeWatcher] Save after sync write failed: ${notebook.uri.path}`, saveError);
            }
        } catch (serializeError) {
            logger.warn(`[FileChangeWatcher] Failed to serialize for sync write: ${fileUri.path}`, serializeError);
        } finally {
            serializeTokenSource.dispose();
        }

        logger.info(`[FileChangeWatcher] Reloaded notebook from external change: ${notebook.uri.path}`);
    }

    /**
     * Execute a snapshot-output-update: read snapshot, apply per-cell updates.
     * Prefers the notebook execution API (outputs set this way respect transientOutputs
     * and do not mark the notebook dirty). Falls back to replaceCells when no kernel is active.
     */
    private async executeSnapshotOutputUpdate(notebook: NotebookDocument, projectId: string): Promise<void> {
        if (!this.snapshotService) {
            return;
        }

        const snapshotOutputs = await this.snapshotService.readSnapshot(projectId);
        if (!snapshotOutputs || snapshotOutputs.size === 0) {
            return;
        }

        // Look up original project blocks for fallback block ID resolution
        const originalProject = this.notebookManager.getOriginalProject(projectId);
        const notebookBlocksMap = new Map<string, DeepnoteBlock[]>();
        if (originalProject) {
            for (const nb of originalProject.project.notebooks) {
                notebookBlocksMap.set(nb.id, nb.blocks);
            }
        }

        const liveCells = notebook.getCells();
        const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;
        const originalBlocks = notebookId ? notebookBlocksMap.get(notebookId) : undefined;

        // Collect cells that need output updates
        const cellUpdates: Array<{
            cellIndex: number;
            cell: NotebookCell;
            newOutputs: NotebookCellOutput[];
            blockId: string;
            blockIdFromFallback: boolean;
        }> = [];

        for (let i = 0; i < liveCells.length; i++) {
            try {
                const cell = liveCells[i];
                let blockId = this.getBlockIdFromMetadata(cell.metadata);
                let blockIdFromFallback = false;

                // Fallback to original project blocks when metadata was lost
                if (!blockId && originalBlocks) {
                    blockId = originalBlocks[i]?.id;
                    blockIdFromFallback = true;
                }

                if (!blockId || !snapshotOutputs.has(blockId)) {
                    continue;
                }

                const fallbackType = originalBlocks?.[i]?.type;
                const blockType = ((cell.metadata?.type as string) ?? fallbackType ?? 'code') as DeepnoteBlock['type'];
                const newOutputs = this.converter.transformOutputsForVsCode(
                    snapshotOutputs.get(blockId)!,
                    i,
                    blockId,
                    blockType,
                    cell.metadata
                );

                // Live state comparison: skip if outputs already match
                if (this.outputsMatch(cell.outputs, newOutputs)) {
                    continue;
                }

                cellUpdates.push({ cellIndex: i, cell, newOutputs, blockId, blockIdFromFallback });
            } catch (error) {
                logger.warn(`[FileChangeWatcher] Failed to process snapshot cell ${i} for ${notebook.uri.path}`, error);
            }
        }

        if (cellUpdates.length === 0) {
            logger.info(`[FileChangeWatcher] Snapshot outputs already match live state: ${notebook.uri.path}`);
            return;
        }

        logger.info(
            `[FileChangeWatcher] Applying snapshot: ${cellUpdates.length} cells updated out of ${liveCells.length}: ${notebook.uri.path}`
        );

        // Try execution API first (outputs set via execution API respect transientOutputs)
        if (await this.tryApplyOutputsViaExecution(notebook, cellUpdates)) {
            // Restore metadata for cells that resolved blockId via fallback
            const metadataEdits: NotebookEdit[] = [];
            for (const update of cellUpdates) {
                if (update.blockIdFromFallback) {
                    metadataEdits.push(
                        NotebookEdit.updateCellMetadata(update.cellIndex, {
                            ...update.cell.metadata,
                            id: update.blockId,
                            __deepnoteBlockId: update.blockId
                        })
                    );
                }
            }
            if (metadataEdits.length > 0) {
                const wsEdit = new WorkspaceEdit();
                wsEdit.set(notebook.uri, metadataEdits);
                await workspace.applyEdit(wsEdit);
            }

            logger.info(`[FileChangeWatcher] Updated notebook outputs via execution API: ${notebook.uri.path}`);
            return;
        }

        // Fallback: use replaceCells when no kernel is available.
        // replaceCells and updateCellMetadata must be in separate WorkspaceEdits
        // because VS Code assigns its own internal ID to the cell's metadata.id
        // when processing replaceCells, overwriting our block ID.
        const replaceEdits: NotebookEdit[] = [];
        for (const update of cellUpdates) {
            const cellData = new NotebookCellData(
                update.cell.kind,
                update.cell.document.getText(),
                update.cell.document.languageId
            );
            cellData.metadata = { ...update.cell.metadata };
            cellData.metadata.id = update.blockId;
            cellData.metadata.__deepnoteBlockId = update.blockId;
            cellData.outputs = update.newOutputs;

            replaceEdits.push(
                NotebookEdit.replaceCells(new NotebookRange(update.cellIndex, update.cellIndex + 1), [cellData])
            );
        }

        const wsEdit = new WorkspaceEdit();
        wsEdit.set(notebook.uri, replaceEdits);
        const applied = await workspace.applyEdit(wsEdit);

        if (!applied) {
            logger.warn(`[FileChangeWatcher] Failed to apply snapshot outputs: ${notebook.uri.path}`);
            return;
        }

        // Restore block IDs in a separate edit so VS Code's internal ID assignment
        // from replaceCells doesn't overwrite our block IDs.
        const metadataEdits: NotebookEdit[] = [];
        for (const update of cellUpdates) {
            metadataEdits.push(
                NotebookEdit.updateCellMetadata(update.cellIndex, {
                    ...update.cell.metadata,
                    id: update.blockId,
                    __deepnoteBlockId: update.blockId
                })
            );
        }
        const metaEdit = new WorkspaceEdit();
        metaEdit.set(notebook.uri, metadataEdits);
        await workspace.applyEdit(metaEdit);

        // Save to sync mtime — mark as self-write first
        this.markSelfWrite(notebook.uri);
        try {
            await workspace.save(notebook.uri);
        } catch (error) {
            this.consumeSelfWrite(notebook.uri);
            throw error;
        }

        logger.info(`[FileChangeWatcher] Updated notebook outputs from external snapshot: ${notebook.uri.path}`);
    }

    private getBlockIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
        return (metadata?.__deepnoteBlockId ?? metadata?.id) as string | undefined;
    }

    /**
     * Normalizes a URI to the underlying file path by stripping query and fragment.
     * Notebook URIs include query params (e.g., ?notebook=id) but the filesystem
     * watcher fires with the raw file URI — keys must match for self-write detection.
     */
    private normalizeFileUri(uri: Uri): string {
        return uri.with({ query: '', fragment: '' }).toString();
    }

    private handleFileChange(uri: Uri): void {
        // Deterministic self-write check — no timers involved
        if (this.consumeSelfWrite(uri)) {
            logger.info(`[FileChangeWatcher] Skipping self-write: ${uri.path}`);
            return;
        }

        if (isSnapshotFile(uri)) {
            this.handleSnapshotFileChange(uri);
            return;
        }

        // Main file change — debounce and enqueue
        const key = uri.toString();
        const existing = this.debounceTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);
                this.enqueueMainFileSync(uri);
            }, debounceTimeInMilliseconds)
        );
    }

    private handleSnapshotFileChange(uri: Uri): void {
        if (!this.snapshotService || !this.snapshotService.isSnapshotsEnabled()) {
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
                this.enqueueSnapshotOutputUpdate(projectId);
            }, debounceTimeInMilliseconds)
        );
    }

    /**
     * Marks a URI as about to be written by us (workspace.save).
     * Call before workspace.save() to prevent the resulting fs event from triggering a reload.
     */
    private markSelfWrite(uri: Uri): void {
        const key = this.normalizeFileUri(uri);
        const count = this.selfWriteCounts.get(key) ?? 0;
        this.selfWriteCounts.set(key, count + 1);

        // Safety net: clean stale entries after 30s
        const existing = this.selfWriteTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        this.selfWriteTimers.set(
            key,
            setTimeout(() => {
                this.selfWriteCounts.delete(key);
                this.selfWriteTimers.delete(key);
            }, selfWriteExpirationMs)
        );
    }

    /**
     * Compares two output arrays for equality.
     * Uses a simple length + JSON comparison for output items.
     */
    private outputsMatch(liveOutputs: readonly NotebookCellOutput[], newOutputs: NotebookCellOutput[]): boolean {
        if (liveOutputs.length !== newOutputs.length) {
            return false;
        }
        if (liveOutputs.length === 0) {
            return true;
        }
        // Compare by checking each output's items
        for (let i = 0; i < liveOutputs.length; i++) {
            const liveMeta = liveOutputs[i].metadata as Record<string, unknown> | undefined;
            const newMeta = newOutputs[i].metadata as Record<string, unknown> | undefined;
            if ((liveMeta?.executionCount as number | undefined) !== (newMeta?.executionCount as number | undefined)) {
                return false;
            }
            const liveItems = liveOutputs[i].items;
            const newItems = newOutputs[i].items;
            if (liveItems.length !== newItems.length) {
                return false;
            }
            for (let j = 0; j < liveItems.length; j++) {
                if (liveItems[j].mime !== newItems[j].mime) {
                    return false;
                }
                // Compare data bytes
                const liveData = liveItems[j].data;
                const newData = newItems[j].data;
                if (liveData.length !== newData.length) {
                    return false;
                }
                for (let k = 0; k < liveData.length; k++) {
                    if (liveData[k] !== newData[k]) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    /**
     * Attempts to apply outputs via the notebook execution API.
     * Outputs set this way respect transientOutputs and do not mark the notebook dirty.
     * Uses the selected controller (available even without a running kernel).
     * Returns true if successful, false if no controller is selected or the operation fails.
     */
    private async tryApplyOutputsViaExecution(
        notebook: NotebookDocument,
        cellUpdates: Array<{ cell: NotebookCell; newOutputs: NotebookCellOutput[] }>
    ): Promise<boolean> {
        const selectedController = this.controllerRegistration?.getSelected(notebook);
        if (!selectedController) {
            return false;
        }

        try {
            const executions = cellUpdates.map((update) => ({
                exec: selectedController.controller.createNotebookCellExecution(update.cell),
                outputs: update.newOutputs
            }));
            for (const { exec, outputs } of executions) {
                exec.start();
                try {
                    await exec.replaceOutput(outputs);
                    exec.end(true);
                } catch (error) {
                    exec.end(false);
                    throw error;
                }
            }
            return true;
        } catch (error) {
            logger.warn(`[FileChangeWatcher] Execution API failed, falling back to replaceCells`, error);
            return false;
        }
    }
}
