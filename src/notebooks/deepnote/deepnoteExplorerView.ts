import { injectable, inject } from 'inversify';
import { commands, window, workspace, type TreeView, Uri, l10n } from 'vscode';
import * as yaml from 'js-yaml';
import { convertIpynbFilesToDeepnoteFile } from '@deepnote/convert';

import { IExtensionContext } from '../../platform/common/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
import { type DeepnoteTreeItem, DeepnoteTreeItemType, type DeepnoteTreeItemContext } from './deepnoteTreeItem';
import { generateUuid } from '../../platform/common/uuid';

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

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.newProject', () => this.newProject())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.importNotebook', () => this.importNotebook())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.importJupyterNotebook', () => this.importJupyterNotebook())
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

    private async newProject(): Promise<void> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            const selection = await window.showInformationMessage(
                l10n.t('No workspace folder is open. Would you like to open a folder?'),
                l10n.t('Open Folder'),
                l10n.t('Cancel')
            );

            if (selection === l10n.t('Open Folder')) {
                await commands.executeCommand('vscode.openFolder');
            }

            return;
        }

        const projectName = await window.showInputBox({
            prompt: l10n.t('Enter a name for the new Deepnote project'),
            placeHolder: l10n.t('My Project'),
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Project name cannot be empty');
                }

                return null;
            }
        });

        if (!projectName) {
            return;
        }

        try {
            const workspaceFolder = workspace.workspaceFolders[0];
            const fileName = `${projectName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.deepnote`;
            const fileUri = Uri.joinPath(workspaceFolder.uri, fileName);

            // Check if file already exists
            try {
                await workspace.fs.stat(fileUri);
                await window.showErrorMessage(
                    l10n.t('A file named "{0}" already exists in this workspace.', fileName)
                );
                return;
            } catch {
                // File doesn't exist, continue
            }

            const projectId = generateUuid();
            const notebookId = generateUuid();

            const firstBlock = {
                blockGroup: generateUuid(),
                content: '',
                executionCount: null,
                id: generateUuid(),
                metadata: {},
                outputs: [],
                sortingKey: '0',
                type: 'code',
                version: 1
            };

            const projectData = {
                version: 1.0,
                metadata: {
                    modifiedAt: new Date().toISOString()
                },
                project: {
                    id: projectId,
                    name: projectName,
                    notebooks: [
                        {
                            blocks: [firstBlock],
                            executionMode: 'block',
                            id: notebookId,
                            name: 'Notebook 1'
                        }
                    ]
                }
            };

            const yamlContent = yaml.dump(projectData);
            const contentBuffer = Buffer.from(yamlContent, 'utf8');

            await workspace.fs.writeFile(fileUri, contentBuffer);

            this.treeDataProvider.refresh();

            this.manager.selectNotebookForProject(projectId, notebookId);

            const notebookUri = fileUri.with({ query: `notebook=${notebookId}` });
            const document = await workspace.openNotebookDocument(notebookUri);

            await window.showNotebookDocument(document, {
                preserveFocus: false,
                preview: false
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(l10n.t(`Failed to create project: {0}`, errorMessage));
        }
    }

    private async importNotebook(): Promise<void> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            const selection = await window.showInformationMessage(
                l10n.t('No workspace folder is open. Would you like to open a folder?'),
                l10n.t('Open Folder'),
                l10n.t('Cancel')
            );

            if (selection === l10n.t('Open Folder')) {
                await commands.executeCommand('vscode.openFolder');
            }

            return;
        }

        const fileUris = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: l10n.t('Import Notebook'),
            filters: {
                Notebooks: ['deepnote', 'ipynb']
            }
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        try {
            const workspaceFolder = workspace.workspaceFolders[0];

            const jupyterUris = fileUris.filter((uri) => uri.path.toLowerCase().endsWith('.ipynb'));
            const deepnoteUris = fileUris.filter((uri) => uri.path.toLowerCase().endsWith('.deepnote'));

            // Check for existing deepnote files
            for (const deepnoteUri of deepnoteUris) {
                const fileName = deepnoteUri.path.split('/').pop() || 'imported.deepnote';
                const targetUri = Uri.joinPath(workspaceFolder.uri, fileName);

                try {
                    await workspace.fs.stat(targetUri);
                    await window.showErrorMessage(
                        l10n.t('A file named "{0}" already exists in this workspace.', fileName)
                    );
                    return;
                } catch {
                    // File doesn't exist, continue
                }
            }

            // Check for existing jupyter import output file
            if (jupyterUris.length > 0) {
                const firstFileName = jupyterUris[0].path.split('/').pop() || 'notebook.ipynb';
                const projectName = firstFileName.replace(/\.ipynb$/i, '');
                const outputFileName = `${projectName}.deepnote`;
                const outputUri = Uri.joinPath(workspaceFolder.uri, outputFileName);

                try {
                    await workspace.fs.stat(outputUri);
                    await window.showErrorMessage(
                        l10n.t('A file named "{0}" already exists in this workspace.', outputFileName)
                    );
                    return;
                } catch {
                    // File doesn't exist, continue
                }
            }

            // Import deepnote files
            for (const deepnoteUri of deepnoteUris) {
                const fileName = deepnoteUri.path.split('/').pop() || 'imported.deepnote';
                const targetUri = Uri.joinPath(workspaceFolder.uri, fileName);

                const content = await workspace.fs.readFile(deepnoteUri);

                await workspace.fs.writeFile(targetUri, content);
            }

            // Convert and import jupyter files
            if (jupyterUris.length > 0) {
                const inputFilePaths = jupyterUris.map((uri) => uri.path);

                // Use the first Jupyter file's name for the project
                const firstFileName = jupyterUris[0].path.split('/').pop() || 'notebook.ipynb';
                const projectName = firstFileName.replace(/\.ipynb$/i, '');
                const outputFileName = `${projectName}.deepnote`;
                const outputPath = Uri.joinPath(workspaceFolder.uri, outputFileName).path;

                await convertIpynbFilesToDeepnoteFile(inputFilePaths, {
                    outputPath: outputPath,
                    projectName: projectName
                });
            }

            const numberOfNotebooks = jupyterUris.length + deepnoteUris.length;

            if (numberOfNotebooks > 1) {
                await window.showInformationMessage(l10n.t('{0} notebooks imported successfully.', numberOfNotebooks));
            } else {
                await window.showInformationMessage(l10n.t('Notebook imported successfully.'));
            }

            this.treeDataProvider.refresh();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(`Failed to import notebook: ${errorMessage}`);
        }
    }

    private async importJupyterNotebook(): Promise<void> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            const selection = await window.showInformationMessage(
                l10n.t('No workspace folder is open. Would you like to open a folder?'),
                l10n.t('Open Folder'),
                l10n.t('Cancel')
            );

            if (selection === l10n.t('Open Folder')) {
                await commands.executeCommand('vscode.openFolder');
            }

            return;
        }

        const fileUris = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: l10n.t('Import Jupyter Notebook'),
            filters: {
                'Jupyter Notebooks': ['ipynb']
            }
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        try {
            const workspaceFolder = workspace.workspaceFolders[0];
            const inputFilePaths = fileUris.map((uri) => uri.path);

            // Use the first Jupyter file's name for the project
            const firstFileName = fileUris[0].path.split('/').pop() || 'notebook.ipynb';
            const projectName = firstFileName.replace(/\.ipynb$/i, '');
            const outputFileName = `${projectName}.deepnote`;
            const outputUri = Uri.joinPath(workspaceFolder.uri, outputFileName);

            // Check if file already exists
            try {
                await workspace.fs.stat(outputUri);
                await window.showErrorMessage(
                    l10n.t('A file named "{0}" already exists in this workspace.', outputFileName)
                );
                return;
            } catch {
                // File doesn't exist, continue
            }

            await convertIpynbFilesToDeepnoteFile(inputFilePaths, {
                outputPath: outputUri.path,
                projectName: projectName
            });

            const numberOfNotebooks = fileUris.length;

            if (numberOfNotebooks > 1) {
                await window.showInformationMessage(
                    l10n.t('{0} Jupyter notebooks imported successfully.', numberOfNotebooks)
                );
            } else {
                await window.showInformationMessage(l10n.t('Jupyter notebook imported successfully.'));
            }

            this.treeDataProvider.refresh();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(l10n.t(`Failed to import Jupyter notebook: {0}`, errorMessage));
        }
    }
}
