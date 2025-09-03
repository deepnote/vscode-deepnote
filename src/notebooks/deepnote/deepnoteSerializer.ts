import { type NotebookData, type NotebookSerializer, type CancellationToken } from 'vscode';
import * as yaml from 'js-yaml';
import { DeepnoteProject, DeepnoteNotebook } from './deepnoteTypes';
import { DeepnoteNotebookManager } from './deepnoteNotebookManager';
import { DeepnoteNotebookSelector } from './deepnoteNotebookSelector';
import { DeepnoteDataConverter } from './deepnoteDataConverter';

export { DeepnoteProject, DeepnoteNotebook, DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';

export class DeepnoteNotebookSerializer implements NotebookSerializer {
    private static manager = new DeepnoteNotebookManager();
    private static selector = new DeepnoteNotebookSelector();
    private static converter = new DeepnoteDataConverter();

    static setSelectedNotebookForUri(uri: string, notebookId: string) {
        this.manager.setSelectedNotebookForUri(uri, notebookId);
    }

    static getSelectedNotebookForUri(uri: string): string | undefined {
        return this.manager.getSelectedNotebookForUri(uri);
    }

    static shouldSkipPrompt(uri: string): boolean {
        return this.manager.shouldSkipPrompt(uri);
    }

    static storeOriginalProject(projectId: string, project: DeepnoteProject, notebookId: string) {
        this.manager.storeOriginalProject(projectId, project, notebookId);
    }

    static getOriginalProject(projectId: string): DeepnoteProject | undefined {
        return this.manager.getOriginalProject(projectId);
    }

    static getCurrentNotebookId(projectId: string): string | undefined {
        return this.manager.getCurrentNotebookId(projectId);
    }

    static getManager(): DeepnoteNotebookManager {
        return this.manager;
    }

    static getConverter(): DeepnoteDataConverter {
        return this.converter;
    }

    async deserializeNotebook(content: Uint8Array, _token: CancellationToken): Promise<NotebookData> {
        try {
            const contentString = Buffer.from(content).toString('utf8');
            const deepnoteProject = yaml.load(contentString) as DeepnoteProject;

            if (!deepnoteProject.project?.notebooks) {
                throw new Error('Invalid Deepnote file: no notebooks found');
            }

            // Select the notebook to open
            const selectedNotebook = await this.selectNotebookForOpen(
                deepnoteProject.project.id,
                deepnoteProject.project.notebooks
            );

            if (!selectedNotebook) {
                throw new Error('No notebook selected');
            }

            const cells = DeepnoteNotebookSerializer.converter.convertBlocksToCells(selectedNotebook.blocks);

            // Store the original project for later serialization
            DeepnoteNotebookSerializer.manager.storeOriginalProject(
                deepnoteProject.project.id,
                deepnoteProject,
                selectedNotebook.id
            );

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
            throw new Error(`Failed to parse Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async serializeNotebook(data: NotebookData, _token: CancellationToken): Promise<Uint8Array> {
        try {
            const projectId = data.metadata?.deepnoteProjectId;
            if (!projectId) {
                throw new Error('Missing Deepnote project ID in notebook metadata');
            }

            const originalProject = DeepnoteNotebookSerializer.manager.getOriginalProject(projectId);
            if (!originalProject) {
                throw new Error('Original Deepnote project not found. Cannot save changes.');
            }

            // Get the current notebook ID (may have changed due to switching)
            const notebookId = data.metadata?.deepnoteNotebookId || DeepnoteNotebookSerializer.manager.getCurrentNotebookId(projectId);
            if (!notebookId) {
                throw new Error('Cannot determine which notebook to save');
            }

            // Find the notebook to update
            const notebookIndex = originalProject.project.notebooks.findIndex(nb => nb.id === notebookId);
            if (notebookIndex === -1) {
                throw new Error(`Notebook with ID ${notebookId} not found in project`);
            }

            // Create a deep copy of the project to modify
            const updatedProject = JSON.parse(JSON.stringify(originalProject)) as DeepnoteProject;

            // Convert cells back to blocks
            const updatedBlocks = DeepnoteNotebookSerializer.converter.convertCellsToBlocks(data.cells);

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
            DeepnoteNotebookSerializer.manager.storeOriginalProject(projectId, updatedProject, notebookId);

            return new TextEncoder().encode(yamlString);
        } catch (error) {
            console.error('Error serializing Deepnote notebook:', error);
            throw new Error(`Failed to save Deepnote file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async selectNotebookForOpen(
        projectId: string,
        notebooks: DeepnoteNotebook[]
    ): Promise<DeepnoteNotebook | undefined> {
        const fileId = projectId;
        const skipPrompt = DeepnoteNotebookSerializer.manager.shouldSkipPrompt(fileId);
        const storedNotebookId = DeepnoteNotebookSerializer.manager.getSelectedNotebookForUri(fileId);

        if (notebooks.length === 1) {
            return notebooks[0];
        }

        if (skipPrompt && storedNotebookId) {
            // Use the stored selection when triggered by command
            const preSelected = notebooks.find(nb => nb.id === storedNotebookId);
            return preSelected || notebooks[0];
        }

        if (storedNotebookId && !skipPrompt) {
            // Normal file open - check if we have a previously selected notebook
            const preSelected = notebooks.find(nb => nb.id === storedNotebookId);
            if (preSelected) {
                return preSelected;
            }
            // Previously selected notebook not found, prompt for selection
        }

        // Prompt user to select a notebook
        const selected = await DeepnoteNotebookSerializer.selector.selectNotebook(notebooks);
        if (selected) {
            DeepnoteNotebookSerializer.manager.setSelectedNotebookForUri(fileId, selected.id);
            return selected;
        }

        // If user cancelled selection, default to the first notebook
        return notebooks[0];
    }

}
