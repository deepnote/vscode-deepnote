import { injectable, inject } from 'inversify';
import { commands, window, workspace, type TreeView, Uri, l10n } from 'vscode';
import * as yaml from 'js-yaml';
import { convertIpynbFilesToDeepnoteFile } from '@deepnote/convert';

import { IExtensionContext } from '../../platform/common/types';
import { IDeepnoteNotebookManager } from '../types';
import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
import { type DeepnoteTreeItem, DeepnoteTreeItemType, type DeepnoteTreeItemContext } from './deepnoteTreeItem';
import { generateUuid } from '../../platform/common/uuid';
import type { DeepnoteFile, DeepnoteNotebook, DeepnoteBlock } from '../../platform/deepnote/deepnoteTypes';

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

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.newNotebook', () => this.newNotebook())
        );

        // Context menu commands for tree items
        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.renameProject', (treeItem: DeepnoteTreeItem) =>
                this.renameProject(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.deleteProject', (treeItem: DeepnoteTreeItem) =>
                this.deleteProject(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.renameNotebook', (treeItem: DeepnoteTreeItem) =>
                this.renameNotebook(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.deleteNotebook', (treeItem: DeepnoteTreeItem) =>
                this.deleteNotebook(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.duplicateNotebook', (treeItem: DeepnoteTreeItem) =>
                this.duplicateNotebook(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand('deepnote.addNotebookToProject', (treeItem: DeepnoteTreeItem) =>
                this.addNotebookToProject(treeItem)
            )
        );
    }

    /**
     * Reads and parses a Deepnote project file from the given URI
     * @param fileUri The URI of the .deepnote file to read
     * @returns The parsed DeepnoteFile data
     */
    private async readDeepnoteProjectFile(fileUri: Uri): Promise<DeepnoteFile> {
        const fileContent = await workspace.fs.readFile(fileUri);
        const yamlContent = new TextDecoder().decode(fileContent);
        const projectData = yaml.load(yamlContent) as DeepnoteFile;
        return projectData;
    }

    /**
     * Generates a suggested unique notebook name based on existing notebooks
     * @param projectData The project data containing existing notebooks
     * @returns A unique suggested notebook name
     */
    private generateSuggestedNotebookName(projectData: DeepnoteFile): string {
        const notebookCount = projectData.project.notebooks?.length || 0;
        const existingNames = new Set(
            projectData.project.notebooks?.map((nb: DeepnoteNotebook) => nb.name.toLowerCase()) || []
        );

        let nextNumber = notebookCount + 1;
        let suggestedName = `Notebook ${nextNumber}`;
        while (existingNames.has(suggestedName.toLowerCase())) {
            nextNumber++;
            suggestedName = `Notebook ${nextNumber}`;
        }

        return suggestedName;
    }

    /**
     * Prompts the user for a notebook name with validation
     * @param suggestedName The default suggested name
     * @returns The entered notebook name, or undefined if cancelled
     */
    private async promptForNotebookName(suggestedName: string): Promise<string | undefined> {
        return await window.showInputBox({
            prompt: l10n.t('Enter a name for the new notebook'),
            placeHolder: suggestedName,
            value: suggestedName,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Notebook name cannot be empty');
                }
                return null;
            }
        });
    }

    /**
     * Creates a new notebook with an initial empty code block
     * @param notebookName The name for the new notebook
     * @returns The created notebook with a unique ID and initial block
     */
    private createNotebookWithFirstBlock(notebookName: string): DeepnoteNotebook {
        const notebookId = generateUuid();
        const firstBlock: DeepnoteBlock = {
            blockGroup: generateUuid(),
            content: '',
            executionCount: undefined,
            id: generateUuid(),
            metadata: {},
            outputs: [],
            sortingKey: '0',
            type: 'code',
            version: 1
        };

        return {
            blocks: [firstBlock],
            executionMode: 'block',
            id: notebookId,
            name: notebookName
        };
    }

    /**
     * Saves the project data to file and opens the specified notebook
     * @param fileUri The URI of the project file
     * @param projectData The project data to save
     * @param projectId The project ID
     * @param notebookId The notebook ID to open
     */
    private async saveProjectAndOpenNotebook(
        fileUri: Uri,
        projectData: DeepnoteFile,
        projectId: string,
        notebookId: string
    ): Promise<void> {
        // Update metadata timestamp
        if (!projectData.metadata) {
            projectData.metadata = { createdAt: new Date().toISOString() };
        }
        projectData.metadata.modifiedAt = new Date().toISOString();

        // Write the updated YAML
        const updatedYaml = yaml.dump(projectData);
        const encoder = new TextEncoder();
        await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

        // Refresh the tree view
        this.treeDataProvider.refresh();

        // Open the new notebook
        this.manager.selectNotebookForProject(projectId, notebookId);
        const notebookUri = fileUri.with({ query: `notebook=${notebookId}` });
        const document = await workspace.openNotebookDocument(notebookUri);
        await window.showNotebookDocument(document, {
            preserveFocus: false,
            preview: false
        });
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
                await window.showErrorMessage(l10n.t('A file named "{0}" already exists in this workspace.', fileName));
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
            const encoder = new TextEncoder();
            const contentBuffer = encoder.encode(yamlContent);

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

    private async newNotebook(): Promise<void> {
        const activeEditor = window.activeNotebookEditor;
        if (!activeEditor || activeEditor.notebook.notebookType !== 'deepnote') {
            await window.showErrorMessage(l10n.t('No active Deepnote file opened. Please open a Deepnote file first.'));
            return;
        }

        const document = activeEditor.notebook;
        const metadata = document.metadata;

        // Get project information from notebook metadata
        const projectId = metadata?.deepnoteProjectId as string | undefined;
        if (!projectId) {
            await window.showErrorMessage(l10n.t('Could not determine project ID'));
            return;
        }

        // Get the file URI (strip query params if present)
        let fileUri = document.uri;
        if (fileUri.query) {
            fileUri = fileUri.with({ query: '' });
        }

        try {
            // Read the current file
            const projectData = await this.readDeepnoteProjectFile(fileUri);

            if (!projectData?.project) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            // Generate suggested name and prompt user
            const suggestedName = this.generateSuggestedNotebookName(projectData);
            const notebookName = await this.promptForNotebookName(suggestedName);

            if (!notebookName) {
                return;
            }

            // Create new notebook with initial block
            const newNotebook = this.createNotebookWithFirstBlock(notebookName);

            // Add new notebook to the project
            if (!projectData.project.notebooks) {
                projectData.project.notebooks = [];
            }
            projectData.project.notebooks.push(newNotebook);

            // Save and open the new notebook
            await this.saveProjectAndOpenNotebook(fileUri, projectData, projectId, newNotebook.id);

            await window.showInformationMessage(l10n.t('Created new notebook: {0}', notebookName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));
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

    // Context menu command implementations

    private async renameProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectFile) {
            return;
        }

        const project = treeItem.data as DeepnoteFile;
        const currentName = project.project.name;

        const newName = await window.showInputBox({
            prompt: l10n.t('Enter new project name'),
            value: currentName,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Project name cannot be empty');
                }
                return null;
            }
        });

        if (!newName || newName === currentName) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await this.readDeepnoteProjectFile(fileUri);

            if (!projectData?.project) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            projectData.project.name = newName;

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = yaml.dump(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            this.treeDataProvider.refresh();
            await window.showInformationMessage(l10n.t('Project renamed to: {0}', newName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename project: {0}', errorMessage));
        }
    }

    private async deleteProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectFile) {
            return;
        }

        const project = treeItem.data as DeepnoteFile;
        const projectName = project.project.name;

        const confirmation = await window.showWarningMessage(
            l10n.t('Are you sure you want to delete project "{0}"?', projectName),
            { modal: true },
            l10n.t('Delete')
        );

        if (confirmation !== l10n.t('Delete')) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            await workspace.fs.delete(fileUri);
            this.treeDataProvider.refresh();
            await window.showInformationMessage(l10n.t('Project deleted: {0}', projectName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to delete project: {0}', errorMessage));
        }
    }

    private async renameNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.Notebook) {
            return;
        }

        const notebook = treeItem.data as DeepnoteNotebook;
        const currentName = notebook.name;

        const newName = await window.showInputBox({
            prompt: l10n.t('Enter new notebook name'),
            value: currentName,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Notebook name cannot be empty');
                }
                return null;
            }
        });

        if (!newName || newName === currentName) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await this.readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            const targetNotebook = projectData.project.notebooks.find(
                (nb: DeepnoteNotebook) => nb.id === treeItem.context.notebookId
            );

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));
                return;
            }

            targetNotebook.name = newName;

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = yaml.dump(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            this.treeDataProvider.refresh();
            await window.showInformationMessage(l10n.t('Notebook renamed to: {0}', newName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename notebook: {0}', errorMessage));
        }
    }

    private async deleteNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.Notebook) {
            return;
        }

        const notebook = treeItem.data as DeepnoteNotebook;
        const notebookName = notebook.name;

        const confirmation = await window.showWarningMessage(
            l10n.t('Are you sure you want to delete notebook "{0}"?', notebookName),
            { modal: true },
            l10n.t('Delete')
        );

        if (confirmation !== l10n.t('Delete')) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await this.readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            projectData.project.notebooks = projectData.project.notebooks.filter(
                (nb: DeepnoteNotebook) => nb.id !== treeItem.context.notebookId
            );

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = yaml.dump(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            this.treeDataProvider.refresh();
            await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to delete notebook: {0}', errorMessage));
        }
    }

    private async duplicateNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.Notebook) {
            return;
        }

        const notebook = treeItem.data as DeepnoteNotebook;
        const originalName = notebook.name;

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await this.readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            const targetNotebook = projectData.project.notebooks.find(
                (nb: DeepnoteNotebook) => nb.id === treeItem.context.notebookId
            );

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));
                return;
            }

            // Generate new name
            const existingNames = new Set(projectData.project.notebooks.map((nb: DeepnoteNotebook) => nb.name));
            let copyNumber = 1;
            let newName = `${originalName} (Copy)`;
            while (existingNames.has(newName)) {
                copyNumber++;
                newName = `${originalName} (Copy ${copyNumber})`;
            }

            // Deep clone the notebook and generate new IDs
            const newNotebook: DeepnoteNotebook = {
                ...targetNotebook,
                id: generateUuid(),
                name: newName,
                blocks: targetNotebook.blocks.map((block: DeepnoteBlock) => ({
                    ...block,
                    id: generateUuid(),
                    blockGroup: generateUuid(),
                    executionCount: undefined
                }))
            };

            projectData.project.notebooks.push(newNotebook);

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = yaml.dump(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            this.treeDataProvider.refresh();

            // Optionally open the duplicated notebook
            this.manager.selectNotebookForProject(treeItem.context.projectId, newNotebook.id);
            const notebookUri = fileUri.with({ query: `notebook=${newNotebook.id}` });
            const document = await workspace.openNotebookDocument(notebookUri);
            await window.showNotebookDocument(document, {
                preserveFocus: false,
                preview: false
            });

            await window.showInformationMessage(l10n.t('Notebook duplicated: {0}', newName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to duplicate notebook: {0}', errorMessage));
        }
    }

    private async addNotebookToProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectFile) {
            return;
        }

        const project = treeItem.data as DeepnoteFile;
        const projectId = project.project.id;

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await this.readDeepnoteProjectFile(fileUri);

            if (!projectData?.project) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            // Generate suggested name and prompt user
            const suggestedName = this.generateSuggestedNotebookName(projectData);
            const notebookName = await this.promptForNotebookName(suggestedName);

            if (!notebookName) {
                return;
            }

            // Create new notebook with initial block
            const newNotebook = this.createNotebookWithFirstBlock(notebookName);

            // Add new notebook to the project
            if (!projectData.project.notebooks) {
                projectData.project.notebooks = [];
            }
            projectData.project.notebooks.push(newNotebook);

            // Save and open the new notebook
            await this.saveProjectAndOpenNotebook(fileUri, projectData, projectId, newNotebook.id);

            await window.showInformationMessage(l10n.t('Created new notebook: {0}', notebookName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));
        }
    }
}
