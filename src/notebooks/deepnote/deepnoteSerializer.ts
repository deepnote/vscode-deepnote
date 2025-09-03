import { type CancellationToken, type NotebookData, type NotebookSerializer } from 'vscode';
import * as yaml from 'js-yaml';
import type { DeepnoteProject, DeepnoteNotebook } from './deepnoteTypes';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { DeepnoteNotebookSelector } from './deepnoteNotebookSelector';
import { DeepnoteDataConverter } from './deepnoteDataConverter';

export { DeepnoteProject, DeepnoteNotebook, DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';

/**
 * Callback function type for handling notebook selection during deserialization.
 * @param projectId Project identifier containing the notebooks
 * @param notebooks Available notebooks to choose from
 * @returns Promise resolving to selected notebook or undefined
 */
export type NotebookSelectionCallback = (
    projectId: string,
    notebooks: DeepnoteNotebook[]
) => Promise<DeepnoteNotebook | undefined>;

/**
 * Serializer for converting between Deepnote YAML files and VS Code notebook format.
 * Handles reading/writing .deepnote files and manages project state persistence.
 */
export class DeepnoteNotebookSerializer implements NotebookSerializer {
    private manager = new DeepnoteNotebookManager();
    private selector = new DeepnoteNotebookSelector();
    private converter = new DeepnoteDataConverter();
    private notebookSelectionCallback?: NotebookSelectionCallback;

    /**
     * Gets the notebook manager instance for accessing project state.
     * @returns DeepnoteNotebookManager instance
     */
    getManager(): DeepnoteNotebookManager {
        return this.manager;
    }

    /**
     * Gets the data converter instance for cell/block conversion.
     * @returns DeepnoteDataConverter instance
     */
    getConverter(): DeepnoteDataConverter {
        return this.converter;
    }

    /**
     * Sets a custom callback for handling notebook selection during deserialization.
     * @param callback Function to call when notebook selection is needed
     */
    setNotebookSelectionCallback(callback: NotebookSelectionCallback) {
        this.notebookSelectionCallback = callback;
    }

    /**
     * Deserializes a Deepnote YAML file into VS Code notebook format.
     * Parses YAML, selects appropriate notebook, and converts blocks to cells.
     * @param content Raw file content as bytes
     * @param _token Cancellation token (unused)
     * @returns Promise resolving to notebook data
     */
    async deserializeNotebook(content: Uint8Array, _token: CancellationToken): Promise<NotebookData> {
        try {
            const contentString = Buffer.from(content).toString('utf8');
            const deepnoteProject = yaml.load(contentString) as DeepnoteProject;

            if (!deepnoteProject.project?.notebooks) {
                throw new Error('Invalid Deepnote file: no notebooks found');
            }

            const selectedNotebook = this.notebookSelectionCallback
                ? await this.notebookSelectionCallback(deepnoteProject.project.id, deepnoteProject.project.notebooks)
                : await this.selectNotebookForOpen(deepnoteProject.project.id, deepnoteProject.project.notebooks);

            if (!selectedNotebook) {
                throw new Error('No notebook selected');
            }

            const cells = this.converter.convertBlocksToCells(selectedNotebook.blocks);

            // Store the original project for later serialization
            this.manager.storeOriginalProject(deepnoteProject.project.id, deepnoteProject, selectedNotebook.id);

            return {
                cells,
                metadata: {
                    deepnoteProjectId: deepnoteProject.project.id,
                    deepnoteProjectName: deepnoteProject.project.name,
                    deepnoteNotebookId: selectedNotebook.id,
                    deepnoteNotebookName: selectedNotebook.name,
                    deepnoteVersion: deepnoteProject.version
                }
            };
        } catch (error) {
            console.error('Error deserializing Deepnote notebook:', error);

            throw new Error(
                `Failed to parse Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Serializes VS Code notebook data back to Deepnote YAML format.
     * Converts cells to blocks, updates project data, and generates YAML.
     * @param data Notebook data to serialize
     * @param _token Cancellation token (unused)
     * @returns Promise resolving to YAML content as bytes
     */
    async serializeNotebook(data: NotebookData, _token: CancellationToken): Promise<Uint8Array> {
        try {
            const projectId = data.metadata?.deepnoteProjectId;
            if (!projectId) {
                throw new Error('Missing Deepnote project ID in notebook metadata');
            }

            const originalProject = this.manager.getOriginalProject(projectId);
            if (!originalProject) {
                throw new Error('Original Deepnote project not found. Cannot save changes.');
            }

            // Get the current notebook ID (may have changed due to switching)
            const notebookId = data.metadata?.deepnoteNotebookId || this.manager.getCurrentNotebookId(projectId);
            if (!notebookId) {
                throw new Error('Cannot determine which notebook to save');
            }

            // Find the notebook to update
            const notebookIndex = originalProject.project.notebooks.findIndex((nb) => nb.id === notebookId);
            if (notebookIndex === -1) {
                throw new Error(`Notebook with ID ${notebookId} not found in project`);
            }

            // Create a deep copy of the project to modify
            const updatedProject = JSON.parse(JSON.stringify(originalProject)) as DeepnoteProject;

            // Convert cells back to blocks
            const updatedBlocks = this.converter.convertCellsToBlocks(data.cells);

            // Update the notebook's blocks
            updatedProject.project.notebooks[notebookIndex].blocks = updatedBlocks;

            // Update modification timestamp
            updatedProject.metadata.modifiedAt = new Date().toISOString();

            // Convert to YAML
            const yamlString = yaml.dump(updatedProject, {
                indent: 2,
                lineWidth: -1,
                noRefs: true,
                sortKeys: false
            });

            // Store the updated project for future saves
            this.manager.storeOriginalProject(projectId, updatedProject, notebookId);

            return new TextEncoder().encode(yamlString);
        } catch (error) {
            console.error('Error serializing Deepnote notebook:', error);
            throw new Error(
                `Failed to save Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    private async selectNotebookForOpen(
        projectId: string,
        notebooks: DeepnoteNotebook[]
    ): Promise<DeepnoteNotebook | undefined> {
        const fileId = projectId;
        const skipPrompt = this.manager.shouldSkipPrompt(fileId);
        const storedNotebookId = this.manager.getSelectedNotebookForUri(fileId);

        if (notebooks.length === 1) {
            return notebooks[0];
        }

        if (skipPrompt && storedNotebookId) {
            // Use the stored selection when triggered by command
            const preSelected = notebooks.find((nb) => nb.id === storedNotebookId);
            return preSelected || notebooks[0];
        }

        if (storedNotebookId && !skipPrompt) {
            // Normal file open - check if we have a previously selected notebook
            const preSelected = notebooks.find((nb) => nb.id === storedNotebookId);
            if (preSelected) {
                return preSelected;
            }
            // Previously selected notebook not found, prompt for selection
        }

        // Prompt user to select a notebook
        const selected = await this.selector.selectNotebook(notebooks);
        if (selected) {
            this.manager.setSelectedNotebookForUri(fileId, selected.id);
            return selected;
        }

        // If user cancelled selection, default to the first notebook
        return notebooks[0];
    }
}
