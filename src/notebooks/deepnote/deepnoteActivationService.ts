import { injectable, inject } from 'inversify';
import { workspace, commands, window, WorkspaceEdit, NotebookEdit, NotebookRange, l10n, Uri } from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IExtensionContext } from '../../platform/common/types';
import { DeepnoteNotebookSerializer } from './deepnoteSerializer';
import type { DeepnoteProject, DeepnoteNotebook } from './deepnoteTypes';
import { DeepnoteNotebookSelector } from './deepnoteNotebookSelector';
import { Commands } from '../../platform/common/constants';

/**
 * Service responsible for activating and configuring Deepnote notebook support in VS Code.
 * Registers serializers, command handlers, and manages the notebook selection workflow.
 */
@injectable()
export class DeepnoteActivationService implements IExtensionSyncActivationService {
    private serializer: DeepnoteNotebookSerializer;
    private selector: DeepnoteNotebookSelector;

    constructor(@inject(IExtensionContext) private extensionContext: IExtensionContext) {}

    /**
     * Activates Deepnote support by registering serializers and commands.
     * Called during extension activation to set up Deepnote integration.
     */
    public activate() {
        this.serializer = new DeepnoteNotebookSerializer();
        this.selector = new DeepnoteNotebookSelector();

        // Set up the custom notebook selection callback
        this.serializer.setNotebookSelectionCallback(this.handleNotebookSelection.bind(this));

        this.extensionContext.subscriptions.push(workspace.registerNotebookSerializer('deepnote', this.serializer));

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.SelectDeepnoteNotebook, () => this.selectNotebook(this.selector))
        );
    }

    private async getDeepnoteProject(notebookUri: Uri, projectId?: string): Promise<DeepnoteProject | undefined> {
        // Try cache first if we have a project ID
        if (projectId) {
            const cachedProject = this.serializer.getManager().getOriginalProject(projectId);
            if (cachedProject) {
                return cachedProject;
            }
        }

        // Cache miss or no project ID - read and parse file
        const rawContent = await workspace.fs.readFile(notebookUri);
        const contentString = Buffer.from(rawContent).toString('utf8');
        const yaml = await import('js-yaml');
        const deepnoteProject = yaml.load(contentString) as DeepnoteProject;

        // Store in cache if we have a project ID
        if (projectId && deepnoteProject) {
            const manager = this.serializer.getManager();
            const currentNotebookId = manager.getCurrentNotebookId(projectId);
            if (currentNotebookId) {
                manager.storeOriginalProject(projectId, deepnoteProject, currentNotebookId);
            }
        }

        return deepnoteProject;
    }

    private async selectNotebook(selector: DeepnoteNotebookSelector) {
        const activeEditor = window.activeNotebookEditor;

        if (!activeEditor || activeEditor.notebook.notebookType !== 'deepnote') {
            await window.showErrorMessage(l10n.t('Please open a Deepnote file first.'));
            return;
        }

        const notebookUri = activeEditor.notebook.uri;
        const projectId = activeEditor.notebook.metadata?.deepnoteProjectId;

        try {
            const deepnoteProject = await this.getDeepnoteProject(notebookUri, projectId);

            if (!deepnoteProject?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file: No notebooks found.'));
                return;
            }

            if (deepnoteProject.project.notebooks.length === 1) {
                await window.showInformationMessage(l10n.t('This Deepnote file contains only one notebook.'));

                return;
            }

            const currentNotebookId = activeEditor.notebook.metadata?.deepnoteNotebookId;

            const selectedNotebook = await selector.selectNotebook(
                deepnoteProject.project.notebooks,
                currentNotebookId,
                {
                    placeHolder: l10n.t('Select a notebook to switch to'),
                    title: l10n.t('Switch Notebook')
                }
            );

            if (selectedNotebook && selectedNotebook.id !== currentNotebookId) {
                // Create new cells from the selected notebook
                const converter = this.serializer.getConverter();
                const cells = converter.convertBlocksToCells(selectedNotebook.blocks);

                // Create a workspace edit to replace all cells
                const edit = new WorkspaceEdit();
                const notebookEdit = NotebookEdit.replaceCells(
                    new NotebookRange(0, activeEditor.notebook.cellCount),
                    cells
                );

                // Also update metadata to reflect the new notebook
                const metadataEdit = NotebookEdit.updateNotebookMetadata({
                    ...activeEditor.notebook.metadata,
                    deepnoteNotebookId: selectedNotebook.id,
                    deepnoteNotebookName: selectedNotebook.name
                });

                edit.set(notebookUri, [notebookEdit, metadataEdit]);

                // Apply the edit
                const success = await workspace.applyEdit(edit);

                if (success) {
                    // Store the selected notebook ID for future reference
                    const fileUri = notebookUri.toString();
                    const projectId = deepnoteProject.project.id;
                    const manager = this.serializer.getManager();
                    manager.setSelectedNotebookForUri(fileUri, selectedNotebook.id);

                    // Update the current notebook ID for serialization
                    manager.storeOriginalProject(
                        projectId,
                        manager.getOriginalProject(projectId) || deepnoteProject,
                        selectedNotebook.id
                    );

                    await window.showInformationMessage(l10n.t('Switched to notebook: {0}', selectedNotebook.name));
                } else {
                    await window.showErrorMessage(l10n.t('Failed to switch notebook.'));
                }
            }
        } catch (error) {
            await window.showErrorMessage(
                l10n.t(
                    'Error switching notebook: {0}',
                    error instanceof Error ? error.message : l10n.t('Unknown error')
                )
            );
        }
    }

    private async handleNotebookSelection(
        projectId: string,
        notebooks: DeepnoteNotebook[]
    ): Promise<DeepnoteNotebook | undefined> {
        const manager = this.serializer.getManager();
        const fileId = projectId;
        const skipPrompt = manager.shouldSkipPrompt(fileId);
        const storedNotebookId = manager.getSelectedNotebookForUri(fileId);

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
            manager.setSelectedNotebookForUri(fileId, selected.id);
            return selected;
        }

        // If user cancelled selection, default to the first notebook
        return notebooks[0];
    }
}
