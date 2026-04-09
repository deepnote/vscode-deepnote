import type { DeepnoteBlock, DeepnoteFile, DeepnoteSnapshot } from '@deepnote/blocks';
import { deserializeDeepnoteFile, isExecutableBlock, serializeDeepnoteSnapshot } from '@deepnote/blocks';
import { inject, injectable, optional } from 'inversify';
import {
    CancellationTokenSource,
    l10n,
    NotebookEdit,
    NotebookRange,
    workspace,
    WorkspaceEdit,
    type CancellationToken,
    type NotebookData,
    type NotebookDocument,
    type NotebookSerializer
} from 'vscode';

import { computeHash } from '../../platform/common/crypto';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { logger } from '../../platform/logging';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { SnapshotService } from './snapshots/snapshotService';

export type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';
export { DeepnoteNotebook, DeepnoteOutput } from '../../platform/deepnote/deepnoteTypes';

/**
 * Deep clones an object while removing circular references.
 * Uses a recursion stack pattern to only drop true cycles, preserving shared references.
 */
function cloneWithoutCircularRefs<T>(obj: T, seen = new WeakSet<object>()): T {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (seen.has(obj as object)) {
        // True circular reference on the current path - drop it
        return undefined as T;
    }

    seen.add(obj as object);

    try {
        if (Array.isArray(obj)) {
            return obj.map((item) => cloneWithoutCircularRefs(item, seen)) as T;
        }

        const clone: Record<string, unknown> = {};

        for (const key of Object.keys(obj as Record<string, unknown>)) {
            clone[key] = cloneWithoutCircularRefs((obj as Record<string, unknown>)[key], seen);
        }

        return clone as T;
    } finally {
        seen.delete(obj as object);
    }
}

const LAST_SERIALIZED_TTL_MS = 10_000;

/**
 * Serializer for converting between Deepnote YAML files and VS Code notebook format.
 * Handles reading/writing .deepnote files and manages project state persistence.
 */
@injectable()
export class DeepnoteNotebookSerializer implements NotebookSerializer {
    private converter = new DeepnoteDataConverter();
    private lastSerializedNotebookId: string | undefined;
    private lastSerializedTimestamp = 0;

    constructor(
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(SnapshotService) @optional() private readonly snapshotService?: SnapshotService
    ) {}

    /**
     * Deserializes a Deepnote YAML file into VS Code notebook format.
     * Parses YAML and converts the selected notebook's blocks to cells.
     * Notebook resolution prefers an explicit notebook ID, then transient
     * resolver state, and finally a deterministic default notebook.
     * @param content Raw file content as bytes
     * @param token Cancellation token (unused)
     * @returns Promise resolving to notebook data
     */
    async deserializeNotebook(
        content: Uint8Array,
        token: CancellationToken,
        notebookId?: string
    ): Promise<NotebookData> {
        logger.debug('DeepnoteSerializer: Deserializing Deepnote notebook');

        if (token?.isCancellationRequested) {
            throw new Error('Serialization cancelled');
        }

        try {
            const contentString = new TextDecoder('utf-8').decode(content);
            const deepnoteFile = deserializeDeepnoteFile(contentString);

            if (!deepnoteFile.project?.notebooks) {
                throw new Error('Invalid Deepnote file: no notebooks found');
            }

            const projectId = deepnoteFile.project.id;
            const resolvedNotebookId = notebookId ?? this.findCurrentNotebookId(projectId);

            logger.debug(`DeepnoteSerializer: Project ID: ${projectId}, Selected notebook ID: ${resolvedNotebookId}`);

            if (!resolvedNotebookId) {
                logger.debug(
                    'DeepnoteSerializer: No notebook ID resolved, returning empty state for post-open verification'
                );

                return {
                    cells: [],
                    metadata: {
                        deepnoteProjectId: projectId,
                        deepnoteProjectName: deepnoteFile.project.name,
                        deepnoteVersion: deepnoteFile.version
                    }
                };
            }

            if (deepnoteFile.project.notebooks.length === 0) {
                throw new Error('Deepnote project contains no notebooks.');
            }

            const selectedNotebook = deepnoteFile.project.notebooks.find((nb) => nb.id === resolvedNotebookId);

            if (!selectedNotebook) {
                throw new Error(l10n.t('No notebook selected or found'));
            }

            // Initialize vega-lite for output conversion (lazy-loaded ESM module)
            await this.converter.initialize();

            if (token?.isCancellationRequested) {
                throw new Error('Serialization cancelled');
            }

            // Log block IDs from source file
            for (let i = 0; i < selectedNotebook.blocks.length; i++) {
                const block = selectedNotebook.blocks[i];
                logger.trace(`DeserializeNotebook: block[${i}] id=${block.id} from source file`);
            }

            let cells = this.converter.convertBlocksToCells(selectedNotebook.blocks);

            logger.debug(`DeepnoteSerializer: Converted ${cells.length} cells from notebook blocks`);

            // Log cell metadata.id after conversion
            for (let i = 0; i < cells.length; i++) {
                logger.trace(`DeserializeNotebook: cell[${i}] metadata.id=${cells[i].metadata?.id} after conversion`);
            }

            // Merge outputs from snapshot if snapshots are enabled
            if (this.snapshotService?.isSnapshotsEnabled()) {
                logger.debug(`[Snapshot] Snapshots enabled, reading snapshot for project ${projectId}`);
                try {
                    const snapshotOutputs = await this.snapshotService.readSnapshot(projectId);

                    if (snapshotOutputs && snapshotOutputs.size > 0) {
                        logger.debug(`[Snapshot] Merging ${snapshotOutputs.size} block outputs from snapshot`);
                        const blocksWithOutputs = this.snapshotService.mergeOutputsIntoBlocks(
                            selectedNotebook.blocks ?? [],
                            snapshotOutputs
                        );

                        cells = this.converter.convertBlocksToCells(blocksWithOutputs);
                    } else {
                        logger.debug(
                            `[Snapshot] No outputs found in snapshot (map was ${
                                snapshotOutputs ? 'empty' : 'undefined'
                            })`
                        );
                    }
                } catch (error) {
                    logger.error(
                        `[Snapshot] Failed to merge snapshot outputs for project ${projectId}, using baseline cells`,
                        error
                    );
                    // Fall back to baseline cells (already set above)
                }
            } else {
                logger.debug(
                    `[Snapshot] Snapshots ${
                        this.snapshotService ? 'disabled' : 'service not available'
                    }, skipping snapshot merge`
                );
            }

            this.notebookManager.storeOriginalProject(deepnoteFile.project.id, deepnoteFile, selectedNotebook.id);
            logger.debug(`DeepnoteSerializer: Stored project ${projectId} in notebook manager`);

            return {
                cells,
                metadata: {
                    deepnoteProjectId: deepnoteFile.project.id,
                    deepnoteProjectName: deepnoteFile.project.name,
                    deepnoteNotebookId: selectedNotebook.id,
                    deepnoteNotebookName: selectedNotebook.name,
                    deepnoteVersion: deepnoteFile.version,
                    name: selectedNotebook.name,
                    display_name: selectedNotebook.name
                }
            };
        } catch (error) {
            logger.error('DeepnoteSerializer: Error deserializing Deepnote notebook', error);

            throw new Error(
                `Failed to parse Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Resolves the notebook ID for a deserialization call.
     *
     * Priority:
     *  1. Pending resolution hint (explicit intent from explorer view)
     *  2. Already-open document metadata (re-deserialization after file change)
     *     — skips the notebook that was just serialized, since that's the one
     *     that triggered the file change, not the one being re-deserialized.
     *  3. undefined — initial open; verifyDeserializedNotebook will resolve
     *     from the document URI after open.
     */
    findCurrentNotebookId(projectId: string): string | undefined {
        const pendingNotebookId = this.notebookManager.consumePendingNotebookResolution(projectId);

        if (pendingNotebookId) {
            return pendingNotebookId;
        }

        return this.findNotebookIdFromOpenDocuments(projectId);
    }

    /**
     * Gets the data converter instance for cell/block conversion.
     * @returns DeepnoteDataConverter instance
     */
    getConverter(): DeepnoteDataConverter {
        return this.converter;
    }

    /**
     * Parses the file content and returns the ID of the default notebook
     * (alphabetically first, excluding Init when other notebooks exist).
     * Used by the post-open verification handler for direct file opens
     * that have no `?notebook=` query param.
     */
    resolveDefaultNotebookId(content: Uint8Array): string | undefined {
        try {
            const contentString = new TextDecoder('utf-8').decode(content);
            const deepnoteFile = deserializeDeepnoteFile(contentString);

            return this.findDefaultNotebook(deepnoteFile)?.id;
        } catch {
            return undefined;
        }
    }

    /**
     * Ensures an opened notebook document shows the correct notebook.
     *
     * The serializer returns an empty state when it cannot determine which
     * notebook to display (no pending resolution). This method is called
     * after the document is created, reads the real notebook ID from
     * the URI `?notebook=` query param (or picks the default notebook
     * for direct file opens), and patches the document in place.
     */
    async verifyDeserializedNotebook(doc: NotebookDocument): Promise<void> {
        if (doc.notebookType !== 'deepnote') {
            return;
        }

        const expectedNotebookId = new URLSearchParams(doc.uri.query).get('notebook');
        const actualNotebookId = doc.metadata?.deepnoteNotebookId as string | undefined;

        if (actualNotebookId && (!expectedNotebookId || expectedNotebookId === actualNotebookId)) {
            return;
        }

        const cts = new CancellationTokenSource();

        try {
            const fileUri = doc.uri.with({ query: '', fragment: '' });
            const content = await workspace.fs.readFile(fileUri);

            const targetNotebookId = expectedNotebookId ?? this.resolveDefaultNotebookId(content);

            if (!targetNotebookId || targetNotebookId === actualNotebookId) {
                return;
            }

            logger.info(
                `Notebook verification: resolving notebook ${targetNotebookId} (was ${actualNotebookId ?? 'empty'}).`
            );

            const correctData = await this.deserializeNotebook(content, cts.token, targetNotebookId);

            const edit = new WorkspaceEdit();

            edit.set(doc.uri, [
                NotebookEdit.replaceCells(new NotebookRange(0, doc.cellCount), correctData.cells),
                NotebookEdit.updateNotebookMetadata(correctData.metadata ?? {})
            ]);

            const applied = await workspace.applyEdit(edit);

            if (applied) {
                await doc.save();
            }
        } catch (error) {
            logger.error('Failed to verify/correct notebook content', error);
        } finally {
            cts.dispose();
        }
    }

    /**
     * Serializes VS Code notebook data back to Deepnote YAML format.
     * Converts cells to blocks, updates project data, and generates YAML.
     * @param data Notebook data to serialize
     * @param token Cancellation token (unused)
     * @returns Promise resolving to YAML content as bytes
     */
    async serializeNotebook(data: NotebookData, token: CancellationToken): Promise<Uint8Array> {
        if (token?.isCancellationRequested) {
            throw new Error('Serialization cancelled');
        }

        try {
            logger.debug('SerializeNotebook: Starting serialization');

            const projectId = data.metadata?.deepnoteProjectId;

            if (!projectId) {
                throw new Error('Missing Deepnote project ID in notebook metadata');
            }

            logger.debug(`SerializeNotebook: Project ID: ${projectId}`);

            // Clone the project before modifying to prevent state corruption
            // This is critical for multi-notebook projects where the stored project
            // is shared between notebook serialization calls
            const storedProject = this.notebookManager.getOriginalProject(projectId) as DeepnoteFile | undefined;

            if (!storedProject) {
                throw new Error('Original Deepnote project not found. Cannot save changes.');
            }

            const originalProject = structuredClone(storedProject);

            logger.debug('SerializeNotebook: Got and cloned original project');

            const notebookId =
                data.metadata?.deepnoteNotebookId || this.notebookManager.getCurrentNotebookId(projectId);

            if (!notebookId) {
                throw new Error('Cannot determine which notebook to save');
            }

            this.lastSerializedNotebookId = notebookId;
            this.lastSerializedTimestamp = Date.now();

            logger.debug(`SerializeNotebook: Notebook ID: ${notebookId}`);

            const notebook = originalProject.project.notebooks.find((nb: { id: string }) => nb.id === notebookId);

            if (!notebook) {
                throw new Error(`Notebook with ID ${notebookId} not found in project`);
            }

            logger.debug(`SerializeNotebook: Found notebook, converting ${data.cells.length} cells to blocks`);

            // Log cell metadata IDs before conversion
            for (let i = 0; i < data.cells.length; i++) {
                const cell = data.cells[i];
                logger.trace(
                    `SerializeNotebook: cell[${i}] metadata.id=${cell.metadata?.id}, metadata keys=${
                        cell.metadata ? Object.keys(cell.metadata).join(',') : 'none'
                    }`
                );
            }

            // Clone blocks while removing circular references that may have been
            // introduced by VS Code's notebook cell/output handling
            const blocks = this.converter.convertCellsToBlocks(data.cells);

            logger.debug(`SerializeNotebook: Converted to ${blocks.length} blocks`);

            // Try to recover block IDs from original blocks when VS Code fails to preserve metadata
            // This uses content-based matching as a fallback when metadata.id is missing
            this.recoverBlockIdsFromOriginal(blocks, notebook.blocks ?? []);

            // Log block IDs after conversion and recovery
            for (let i = 0; i < blocks.length; i++) {
                logger.trace(`SerializeNotebook: block[${i}] id=${blocks[i].id}`);
            }

            // Add snapshot metadata to blocks (contentHash and execution timing)
            await this.addSnapshotMetadataToBlocks(blocks, data);

            // Handle snapshot mode: strip outputs and execution metadata from main file
            if (this.snapshotService?.isSnapshotsEnabled()) {
                // Strip outputs and execution timestamps from main file blocks
                // Also clone to remove circular references that may cause serialization to fail
                const strippedBlocks = this.snapshotService.stripOutputsFromBlocks(blocks);
                notebook.blocks = cloneWithoutCircularRefs<DeepnoteBlock[]>(strippedBlocks);

                // Remove top-level execution and environment metadata from main file
                delete originalProject.execution;
                delete originalProject.environment;

                logger.debug('SerializeNotebook: Stripped outputs and metadata (snapshot mode)');
            } else {
                // Default behavior: outputs in main file
                notebook.blocks = cloneWithoutCircularRefs<DeepnoteBlock[]>(blocks);

                // Add environment and execution metadata from snapshot service
                await this.addSnapshotMetadataToProject(originalProject, data);
            }

            logger.debug('SerializeNotebook: Cloned blocks, computing snapshotHash');

            // Compute snapshot hash from all execution-affecting factors
            (originalProject.metadata as { snapshotHash?: string }).snapshotHash = await this.computeSnapshotHash(
                originalProject
            );

            // Update modifiedAt conditionally based on snapshot mode
            if (this.snapshotService?.isSnapshotsEnabled()) {
                // In snapshot mode, only update modifiedAt if content actually changed
                const hasContentChanges = this.detectContentChanges(originalProject, storedProject);

                if (hasContentChanges) {
                    originalProject.metadata.modifiedAt = new Date().toISOString();
                } else {
                    // Preserve the original modifiedAt (may be undefined)
                    originalProject.metadata.modifiedAt = storedProject.metadata?.modifiedAt;
                }
            } else {
                // Default behavior: always update modifiedAt
                originalProject.metadata.modifiedAt = new Date().toISOString();
            }

            // Store the updated project back so subsequent saves start from correct state.
            // Use updateOriginalProject (not storeOriginalProject) to avoid overwriting
            // currentNotebookId — when multiple notebooks share the same file, changing
            // currentNotebookId here would cause VS Code's follow-up deserialize calls
            // for other open notebooks to resolve to the wrong notebook.
            this.notebookManager.updateOriginalProject(projectId, originalProject);

            logger.debug('SerializeNotebook: Serializing to YAML');

            const projectToSerialize = {
                ...originalProject,
                environment: originalProject.environment ?? {},
                execution: originalProject.execution ?? {}
            } as DeepnoteSnapshot;
            const yamlString = serializeDeepnoteSnapshot(projectToSerialize);

            logger.debug(`SerializeNotebook: Serialization complete, ${yamlString.length} chars`);

            return new TextEncoder().encode(yamlString);
        } catch (error) {
            logger.error('DeepnoteSerializer: Error serializing Deepnote notebook', error);
            throw new Error(
                `Failed to save Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Adds snapshot metadata (contentHash, execution timing) to blocks.
     */
    private async addSnapshotMetadataToBlocks(blocks: DeepnoteBlock[], data: NotebookData): Promise<void> {
        const notebookUri = this.findNotebookUri(data);

        logger.debug(`[Snapshot] addSnapshotMetadataToBlocks: ${blocks.length} blocks`);
        logger.debug(`[Snapshot] snapshotService exists: ${!!this.snapshotService}`);
        logger.debug(`[Snapshot] notebookUri: ${notebookUri}`);

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const cell = data.cells[i];

            if (block.content) {
                try {
                    const hash = await computeHash(block.content, 'SHA-256');

                    block.contentHash = `sha256:${hash}`;
                } catch (error) {
                    logger.warn('Failed to compute contentHash', error);
                }
            }

            if (this.snapshotService && notebookUri && cell?.metadata?.id && isExecutableBlock(block)) {
                const cellId = cell.metadata.id as string;
                const executionMetadata = this.snapshotService.getBlockExecutionMetadata(notebookUri, cellId);

                if (executionMetadata) {
                    if (executionMetadata.executionStartedAt) {
                        block.executionStartedAt = executionMetadata.executionStartedAt;
                    }

                    if (executionMetadata.executionFinishedAt) {
                        block.executionFinishedAt = executionMetadata.executionFinishedAt;
                    }
                }
            }
        }
    }

    /**
     * Adds environment and execution metadata to the project.
     */
    private async addSnapshotMetadataToProject(project: DeepnoteFile, data: NotebookData): Promise<void> {
        logger.debug('[Serializer] addSnapshotMetadataToProject called');
        logger.debug(`[Serializer] snapshotService exists: ${!!this.snapshotService}`);

        if (!this.snapshotService) {
            logger.debug('[Serializer] No snapshotService, skipping metadata');

            return;
        }

        const notebookUri = this.findNotebookUri(data);

        logger.debug(`[Serializer] findNotebookUri returned: ${notebookUri}`);

        if (!notebookUri) {
            logger.debug('[Serializer] No notebookUri found, skipping metadata');

            return;
        }

        const executionMetadata = this.snapshotService.getExecutionMetadata(notebookUri);

        logger.debug(`[Serializer] executionMetadata exists: ${!!executionMetadata}`);

        if (executionMetadata) {
            project.execution = executionMetadata;
            logger.debug('[Serializer] Added execution metadata');
        }

        logger.debug('[Serializer] Fetching environment metadata.');

        const environmentMetadata = await this.snapshotService.getEnvironmentMetadata(notebookUri);

        logger.debug(`[Serializer] Finished fetching environment metadata.`);

        if (environmentMetadata) {
            project.environment = environmentMetadata;

            logger.debug('[Serializer] Added environment metadata.');
        } else {
            logger.debug('[Serializer] No environment metadata returned.');
        }
    }

    /**
     * Computes a deterministic hash of all factors that affect notebook execution and outputs.
     * Includes contentHashes from all blocks, environment hash, version, and integrations.
     * Excludes temporal fields to ensure identical snapshots produce identical hashes.
     */
    private async computeSnapshotHash(project: DeepnoteFile): Promise<string> {
        // Collect all block contentHashes (sorted for determinism)
        const contentHashes: string[] = [];

        for (const notebook of project.project.notebooks) {
            for (const block of notebook.blocks ?? []) {
                if (block.contentHash) {
                    contentHashes.push(block.contentHash);
                }
            }
        }

        contentHashes.sort();

        // Build deterministic hash input
        const hashInput = {
            contentHashes,
            environmentHash: project.environment?.hash ?? null,
            integrations: (project.project.integrations ?? [])
                .map((i) => ({ id: i.id, name: i.name, type: i.type }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            version: project.version
        };

        const hashData = JSON.stringify(hashInput);
        const hash = await computeHash(hashData, 'SHA-256');

        return `sha256:${hash}`;
    }

    /**
     * Detects whether actual content has changed between two project versions.
     * Compares notebook content (block sources, types, and IDs) while ignoring
     * outputs, execution metadata, and timestamps.
     * @param newProject The project with potential changes
     * @param originalProject The stored original project
     * @returns true if content has changed, false otherwise
     */
    private detectContentChanges(newProject: DeepnoteFile, originalProject: DeepnoteFile): boolean {
        for (const originalNotebook of originalProject.project.notebooks) {
            const newNotebook = newProject.project.notebooks.find((nb) => nb.id === originalNotebook.id);

            if (!newNotebook) {
                return true; // Notebook removed
            }
        }

        for (const newNotebook of newProject.project.notebooks) {
            const originalNotebook = originalProject.project.notebooks.find((nb) => nb.id === newNotebook.id);

            if (!originalNotebook) {
                return true; // New notebook added
            }

            if (
                newNotebook.name !== originalNotebook.name ||
                newNotebook.executionMode !== originalNotebook.executionMode ||
                newNotebook.isModule !== originalNotebook.isModule ||
                newNotebook.workingDirectory !== originalNotebook.workingDirectory
            ) {
                return true;
            }

            const newBlocks = newNotebook.blocks ?? [];
            const originalBlocks = originalNotebook.blocks ?? [];

            if (newBlocks.length !== originalBlocks.length) {
                return true;
            }

            for (let i = 0; i < newBlocks.length; i++) {
                const newBlock = newBlocks[i];
                const originalBlock = originalBlocks[i];

                // Compare content and type (the things that matter for actual changes)
                if (
                    newBlock.content !== originalBlock.content ||
                    newBlock.type !== originalBlock.type ||
                    newBlock.id !== originalBlock.id
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Returns a notebook ID from an already-open document for re-deserialization.
     *
     * When VS Code re-reads a file (e.g. after save or external change), it
     * calls deserializeNotebook again for each open document backed by that
     * file.  The document already exists in workspace.notebookDocuments with
     * the correct deepnoteNotebookId in its metadata.
     *
     * Skips the notebook that was most recently serialized — that document
     * triggered the file change and is not the one being re-deserialized.
     */
    private findNotebookIdFromOpenDocuments(projectId: string): string | undefined {
        const recentSerialize =
            this.lastSerializedNotebookId && Date.now() - this.lastSerializedTimestamp < LAST_SERIALIZED_TTL_MS;

        for (const doc of workspace.notebookDocuments) {
            if (doc.notebookType !== 'deepnote' || doc.metadata?.deepnoteProjectId !== projectId) {
                continue;
            }

            const notebookId = doc.metadata?.deepnoteNotebookId as string | undefined;

            if (!notebookId) {
                continue;
            }

            if (recentSerialize && notebookId === this.lastSerializedNotebookId) {
                continue;
            }

            return notebookId;
        }

        return undefined;
    }

    /**
     * Finds the default notebook to open when no selection is made.
     * @param file
     * @returns
     */
    private findDefaultNotebook(file: DeepnoteFile): DeepnoteNotebook | undefined {
        if (file.project.notebooks.length === 0) {
            return undefined;
        }

        const sortedNotebooks = file.project.notebooks.slice().sort((a, b) => a.name.localeCompare(b.name));
        const sortedNotebooksWithoutInit = file.project.initNotebookId
            ? sortedNotebooks.filter((nb) => nb.id !== file.project.initNotebookId)
            : sortedNotebooks;

        if (sortedNotebooksWithoutInit.length > 0) {
            return sortedNotebooksWithoutInit[0];
        }

        return sortedNotebooks[0];
    }

    /**
     * Finds the notebook URI from the metadata.
     */
    private findNotebookUri(data: NotebookData): string | undefined {
        const projectId = data.metadata?.deepnoteProjectId;
        const notebookId = data.metadata?.deepnoteNotebookId;

        if (!projectId || !notebookId) {
            return;
        }

        const notebookDoc = workspace.notebookDocuments.find(
            (doc) =>
                doc.notebookType === 'deepnote' &&
                doc.metadata?.deepnoteProjectId === projectId &&
                doc.metadata?.deepnoteNotebookId === notebookId
        );

        return notebookDoc?.uri.toString();
    }

    /**
     * Attempts to recover block metadata when VS Code fails to preserve cell metadata.
     * Uses content-based matching as a fallback strategy to recover id, sortingKey, and blockGroup.
     * @param blocks Blocks converted from cells (may have generated values if metadata was lost)
     * @param originalBlocks Original blocks from the stored project
     */
    private recoverBlockIdsFromOriginal(blocks: DeepnoteBlock[], originalBlocks: DeepnoteBlock[]): void {
        // Build a map of original blocks by content for quick lookup
        // Key: content (trimmed), Value: array of blocks with that content (in case of duplicates)
        const contentToOriginalBlocks = new Map<string, DeepnoteBlock[]>();

        for (const originalBlock of originalBlocks) {
            const content = (originalBlock.content || '').trim();
            const existing = contentToOriginalBlocks.get(content) || [];

            existing.push(originalBlock);
            contentToOriginalBlocks.set(content, existing);
        }

        // Track which original block IDs have been claimed to avoid duplicates
        const claimedIds = new Set<string>();
        const originalIds = new Set(originalBlocks.map((block) => block.id));

        // First pass: mark IDs that are already correctly set from metadata
        for (const block of blocks) {
            if (originalIds.has(block.id)) {
                claimedIds.add(block.id);
            }
        }

        // Second pass: try to recover metadata for blocks that got new generated values
        let recoveredCount = 0;

        for (const block of blocks) {
            // Skip if this block already has an original ID
            if (claimedIds.has(block.id)) {
                continue;
            }

            // Try to find a matching original block by content
            const content = (block.content || '').trim();
            const candidates = contentToOriginalBlocks.get(content) || [];

            // Find an unclaimed candidate
            for (const candidate of candidates) {
                if (!claimedIds.has(candidate.id)) {
                    const oldId = block.id;

                    // Recover all key metadata from the original block
                    block.id = candidate.id;
                    block.sortingKey = candidate.sortingKey;
                    block.blockGroup = candidate.blockGroup;

                    claimedIds.add(candidate.id);
                    recoveredCount++;

                    logger.debug(
                        `SerializeNotebook: Recovered block metadata for ${candidate.id} (was ${oldId}) via content match`
                    );
                    break;
                }
            }
        }

        if (recoveredCount > 0) {
            logger.info(
                `SerializeNotebook: Recovered ${recoveredCount} blocks via content matching ` +
                    `(VS Code metadata may have been lost)`
            );
        }
    }
}
