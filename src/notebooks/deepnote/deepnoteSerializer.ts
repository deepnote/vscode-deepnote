import { inject, injectable, optional } from 'inversify';
import * as yaml from 'js-yaml';
import { l10n, workspace, type CancellationToken, type NotebookData, type NotebookSerializer } from 'vscode';

import { logger } from '../../platform/logging';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import type { DeepnoteBlock, DeepnoteFile, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { ISnapshotMetadataService, ISnapshotMetadataServiceFull } from './snapshotMetadataService';
import { computeHash } from '../../platform/common/crypto';

export { DeepnoteBlock, DeepnoteNotebook, DeepnoteOutput, DeepnoteFile } from '../../platform/deepnote/deepnoteTypes';

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

/**
 * Serializer for converting between Deepnote YAML files and VS Code notebook format.
 * Handles reading/writing .deepnote files and manages project state persistence.
 */
@injectable()
export class DeepnoteNotebookSerializer implements NotebookSerializer {
    private converter = new DeepnoteDataConverter();

    constructor(
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(ISnapshotMetadataService) @optional() private readonly snapshotService?: ISnapshotMetadataServiceFull
    ) {}

    /**
     * Gets the data converter instance for cell/block conversion.
     * @returns DeepnoteDataConverter instance
     */
    getConverter(): DeepnoteDataConverter {
        return this.converter;
    }

    /**
     * Deserializes a Deepnote YAML file into VS Code notebook format.
     * Parses YAML and converts the selected notebook's blocks to cells.
     * The notebook to deserialize must be pre-selected and stored in the manager.
     * @param content Raw file content as bytes
     * @param token Cancellation token (unused)
     * @returns Promise resolving to notebook data
     */
    async deserializeNotebook(content: Uint8Array, token: CancellationToken): Promise<NotebookData> {
        logger.debug('DeepnoteSerializer: Deserializing Deepnote notebook');

        if (token?.isCancellationRequested) {
            throw new Error('Serialization cancelled');
        }

        // Initialize vega-lite for output conversion (lazy-loaded ESM module)
        await this.converter.initialize();

        if (token?.isCancellationRequested) {
            throw new Error('Serialization cancelled');
        }

        try {
            const contentString = new TextDecoder('utf-8').decode(content);
            const deepnoteFile = yaml.load(contentString) as DeepnoteFile;

            if (!deepnoteFile.project?.notebooks) {
                throw new Error('Invalid Deepnote file: no notebooks found');
            }

            const projectId = deepnoteFile.project.id;
            const notebookId = this.findCurrentNotebookId(projectId);

            logger.debug(`DeepnoteSerializer: Project ID: ${projectId}, Selected notebook ID: ${notebookId}`);

            if (deepnoteFile.project.notebooks.length === 0) {
                throw new Error('Deepnote project contains no notebooks.');
            }

            const selectedNotebook = notebookId
                ? deepnoteFile.project.notebooks.find((nb) => nb.id === notebookId)
                : this.findDefaultNotebook(deepnoteFile);

            if (!selectedNotebook) {
                throw new Error(l10n.t('No notebook selected or found'));
            }

            const cells = this.converter.convertBlocksToCells(selectedNotebook.blocks ?? []);

            logger.debug(`DeepnoteSerializer: Converted ${cells.length} cells from notebook blocks`);

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

            const originalProject = this.notebookManager.getOriginalProject(projectId) as DeepnoteFile | undefined;

            if (!originalProject) {
                throw new Error('Original Deepnote project not found. Cannot save changes.');
            }

            logger.debug('SerializeNotebook: Got original project');

            const notebookId =
                data.metadata?.deepnoteNotebookId || this.notebookManager.getTheSelectedNotebookForAProject(projectId);

            if (!notebookId) {
                throw new Error('Cannot determine which notebook to save');
            }

            logger.debug(`SerializeNotebook: Notebook ID: ${notebookId}`);

            const notebook = originalProject.project.notebooks.find((nb: { id: string }) => nb.id === notebookId);

            if (!notebook) {
                throw new Error(`Notebook with ID ${notebookId} not found in project`);
            }

            logger.debug(`SerializeNotebook: Found notebook, converting ${data.cells.length} cells to blocks`);

            // Clone blocks while removing circular references that may have been
            // introduced by VS Code's notebook cell/output handling
            const blocks = this.converter.convertCellsToBlocks(data.cells);

            logger.debug(`SerializeNotebook: Converted to ${blocks.length} blocks, now cloning without circular refs`);

            // Add snapshot metadata to blocks (contentHash and execution timing)
            await this.addSnapshotMetadataToBlocks(blocks, data);

            notebook.blocks = cloneWithoutCircularRefs<DeepnoteBlock[]>(blocks);

            logger.debug('SerializeNotebook: Cloned blocks, updating modifiedAt');

            originalProject.metadata.modifiedAt = new Date().toISOString();

            // Add environment and execution metadata from snapshot service
            await this.addSnapshotMetadataToProject(originalProject, data);

            logger.debug('SerializeNotebook: Starting yaml.dump');

            const yamlString = yaml.dump(originalProject, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                sortKeys: false
            });

            logger.debug(`SerializeNotebook: yaml.dump complete, ${yamlString.length} chars`);

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

            if (this.snapshotService && notebookUri && cell?.metadata?.id) {
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
     * Finds the notebook ID to deserialize by checking the manager's stored selection.
     * The notebook ID should be set via selectNotebookForProject before opening the document.
     * @param projectId The project ID to find a notebook for
     * @returns The notebook ID to deserialize, or undefined if none found
     */
    findCurrentNotebookId(projectId: string): string | undefined {
        // Check the manager's stored selection - this should be set when opening from explorer
        const storedNotebookId = this.notebookManager.getTheSelectedNotebookForAProject(projectId);

        if (storedNotebookId) {
            return storedNotebookId;
        }

        // Fallback: Check if there's an active notebook document for this project
        const activeNotebook = workspace.notebookDocuments.find(
            (doc) => doc.notebookType === 'deepnote' && doc.metadata?.deepnoteProjectId === projectId
        );

        return activeNotebook?.metadata?.deepnoteNotebookId;
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
}
