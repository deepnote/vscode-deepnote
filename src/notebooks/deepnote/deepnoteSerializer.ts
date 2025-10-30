import { inject, injectable } from 'inversify';
import * as yaml from 'js-yaml';
import { l10n, workspace, type CancellationToken, type NotebookData, type NotebookSerializer } from 'vscode';

import { logger } from '../../platform/logging';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import type { DeepnoteFile, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

export { DeepnoteBlock, DeepnoteNotebook, DeepnoteOutput, DeepnoteFile } from '../../platform/deepnote/deepnoteTypes';

/**
 * Serializer for converting between Deepnote YAML files and VS Code notebook format.
 * Handles reading/writing .deepnote files and manages project state persistence.
 */
@injectable()
export class DeepnoteNotebookSerializer implements NotebookSerializer {
    private converter = new DeepnoteDataConverter();

    constructor(@inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager) {}

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
            const projectId = data.metadata?.deepnoteProjectId;

            if (!projectId) {
                throw new Error('Missing Deepnote project ID in notebook metadata');
            }

            const originalProject = this.notebookManager.getOriginalProject(projectId) as DeepnoteFile | undefined;

            if (!originalProject) {
                throw new Error('Original Deepnote project not found. Cannot save changes.');
            }

            const notebookId =
                data.metadata?.deepnoteNotebookId || this.notebookManager.getTheSelectedNotebookForAProject(projectId);

            if (!notebookId) {
                throw new Error('Cannot determine which notebook to save');
            }

            const notebookIndex = originalProject.project.notebooks.findIndex(
                (nb: { id: string }) => nb.id === notebookId
            );

            if (notebookIndex === -1) {
                throw new Error(`Notebook with ID ${notebookId} not found in project`);
            }

            const updatedProject = JSON.parse(JSON.stringify(originalProject)) as DeepnoteFile;

            const updatedBlocks = this.converter.convertCellsToBlocks(data.cells);

            updatedProject.project.notebooks[notebookIndex].blocks = updatedBlocks;

            updatedProject.metadata.modifiedAt = new Date().toISOString();

            const yamlString = yaml.dump(updatedProject, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                sortKeys: false
            });

            this.notebookManager.storeOriginalProject(projectId, updatedProject, notebookId);

            return new TextEncoder().encode(yamlString);
        } catch (error) {
            logger.error('DeepnoteSerializer: Error serializing Deepnote notebook', error);
            throw new Error(
                `Failed to save Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
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
