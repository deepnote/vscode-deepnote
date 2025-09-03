import { injectable, inject } from 'inversify'
import { workspace, commands, window, WorkspaceEdit, NotebookEdit, NotebookRange, l10n } from 'vscode'
import { IExtensionSyncActivationService } from '../../platform/activation/types'
import { IExtensionContext } from '../../platform/common/types'
import { DeepnoteNotebookSerializer } from './deepnoteSerializer'
import { DeepnoteProject } from './deepnoteTypes'
import { DeepnoteNotebookSelector } from './deepnoteNotebookSelector'
import { Commands } from '../../platform/common/constants'

@injectable()
export class DeepnoteActivationService implements IExtensionSyncActivationService {
    constructor(
        @inject(IExtensionContext) private extensionContext: IExtensionContext
    ) {}

    public activate() {
        const serializer = new DeepnoteNotebookSerializer();
        const selector = new DeepnoteNotebookSelector();

        this.extensionContext.subscriptions.push(
            workspace.registerNotebookSerializer('deepnote', serializer)
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.SelectDeepnoteNotebook, () => this.selectNotebook(selector))
        );
    }

    private async selectNotebook(selector: DeepnoteNotebookSelector) {
        const activeEditor = window.activeNotebookEditor;

        if (!activeEditor || activeEditor.notebook.notebookType !== 'deepnote') {
            await window.showErrorMessage(l10n.t('Please open a Deepnote file first.'));

            return;
        }

        const notebookUri = activeEditor.notebook.uri;
        const rawContent = await workspace.fs.readFile(notebookUri);
        const contentString = Buffer.from(rawContent).toString('utf8');

        try {
            const yaml = await import('js-yaml');
            const deepnoteProject = yaml.load(contentString) as DeepnoteProject;

            if (!deepnoteProject.project?.notebooks) {
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
                const converter = DeepnoteNotebookSerializer.getConverter();
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
                    const manager = DeepnoteNotebookSerializer.getManager();
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
            await window.showErrorMessage(l10n.t('Error switching notebook: {0}', error instanceof Error ? error.message : l10n.t('Unknown error')));
        }
    }
}
