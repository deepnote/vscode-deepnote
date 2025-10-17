import { injectable, inject } from 'inversify';
import { commands, window, workspace, TreeView, Uri, l10n } from 'vscode';

import { IExtensionContext } from '../../platform/common/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
import { type DeepnoteTreeItem, DeepnoteTreeItemType, type DeepnoteTreeItemContext } from './deepnoteTreeItem';

/**
 * Manages the Deepnote explorer tree view and related commands
 */
@injectable()
export class DeepnoteExplorerView {
    private readonly treeDataProvider: DeepnoteTreeDataProvider;

    private treeView: TreeView<DeepnoteTreeItem>;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IDeepnoteNotebookManager) private readonly manager: IDeepnoteNotebookManager
    ) {
        this.treeDataProvider = new DeepnoteTreeDataProvider();
    }

    public activate(): void {
        this.treeView = window.createTreeView('deepnoteExplorer', {
            treeDataProvider: this.treeDataProvider,
            showCollapseAll: true
        });

        this.extensionContext.subscriptions.push(this.treeView);
        this.extensionContext.subscriptions.push(this.treeDataProvider);

        this.registerCommands();
    }

    private registerCommands(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.refreshExplorer', () => this.refreshExplorer())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.openNotebook', (context: DeepnoteTreeItemContext) =>
                this.openNotebook(context)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.openFile', (treeItem: DeepnoteTreeItem) => this.openFile(treeItem))
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.revealInExplorer', () => this.revealActiveNotebook())
        );
    }

    private refreshExplorer(): void {
        this.treeDataProvider.refresh();
    }

    private async openNotebook(context: DeepnoteTreeItemContext): Promise<void> {
        console.log(`Opening notebook: ${context.notebookId} in project: ${context.projectId}.`);

        if (!context.notebookId) {
            await window.showWarningMessage(l10n.t('Cannot open: missing notebook id.'));

            return;
        }

        try {
            // Create a unique URI by adding the notebook ID as a query parameter
            // This ensures VS Code treats each notebook as a separate document
            const fileUri = Uri.file(context.filePath).with({ query: `notebook=${context.notebookId}` });

            console.log(`Selecting notebook in manager.`);

            this.manager.selectNotebookForProject(context.projectId, context.notebookId);

            console.log(`Opening notebook document.`, fileUri);

            const document = await workspace.openNotebookDocument(fileUri);

            console.log(`Showing notebook document.`);

            await window.showNotebookDocument(document, {
                preview: false,
                preserveFocus: false
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(`Failed to open notebook: ${errorMessage}`);
        }
    }

    private async openFile(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectFile) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const document = await workspace.openTextDocument(fileUri);

            await window.showTextDocument(document);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(`Failed to open file: ${errorMessage}`);
        }
    }

    private async revealActiveNotebook(): Promise<void> {
        const activeEditor = window.activeNotebookEditor;
        if (!activeEditor || activeEditor.notebook.notebookType !== 'deepnote') {
            await window.showInformationMessage('No active Deepnote notebook found.');
            return;
        }

        const notebookMetadata = activeEditor.notebook.metadata;
        const projectId = notebookMetadata?.deepnoteProjectId;
        const notebookId = notebookMetadata?.deepnoteNotebookId;

        if (!projectId || !notebookId) {
            await window.showWarningMessage('Cannot reveal notebook: missing metadata.');
            return;
        }

        // Try to reveal the notebook in the explorer
        try {
            const treeItem = await this.treeDataProvider.findTreeItem(projectId, notebookId);

            if (treeItem) {
                await this.treeView.reveal(treeItem, { select: true, focus: true, expand: true });
            } else {
                // Fall back to showing information if node not found
                await window.showInformationMessage(
                    `Active notebook: ${notebookMetadata?.deepnoteNotebookName || 'Untitled'} in project ${
                        notebookMetadata?.deepnoteProjectName || 'Untitled'
                    }`
                );
            }
        } catch (error) {
            // Fall back to showing information if reveal fails
            console.error('Failed to reveal notebook in explorer:', error);
            await window.showInformationMessage(
                `Active notebook: ${notebookMetadata?.deepnoteNotebookName || 'Untitled'} in project ${
                    notebookMetadata?.deepnoteProjectName || 'Untitled'
                }`
            );
        }
    }
}
