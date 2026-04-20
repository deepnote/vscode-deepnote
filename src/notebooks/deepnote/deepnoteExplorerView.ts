import { injectable, inject } from 'inversify';
import { commands, RelativePattern, window, workspace, type TreeView, Uri, l10n } from 'vscode';
import { serializeDeepnoteFile, type DeepnoteBlock, type DeepnoteFile } from '@deepnote/blocks';
import { convertDeepnoteToJupyterNotebooks, convertIpynbFilesToDeepnoteFile } from '@deepnote/convert';

import { IExtensionContext } from '../../platform/common/types';

import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
import {
    type DeepnoteTreeItem,
    DeepnoteTreeItemType,
    type DeepnoteTreeItemContext,
    getSingleNonInitNotebook,
    NOTEBOOK_FILE_CONTEXT_VALUE,
    type ProjectGroupData
} from './deepnoteTreeItem';
import { uuidUtils } from '../../platform/common/uuid';
import type { DeepnoteNotebook, DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';
import { Commands } from '../../platform/common/constants';
import { buildSiblingNotebookFileUri, buildSingleNotebookFile } from './deepnoteNotebookFileFactory';
import { readDeepnoteProjectFile } from './deepnoteProjectUtils';
import { SNAPSHOT_FILE_SUFFIX } from './snapshots/snapshotFiles';
import { ILogger } from '../../platform/logging/types';

/**
 * Manages the Deepnote explorer tree view and related commands
 */
@injectable()
export class DeepnoteExplorerView {
    private readonly logger: ILogger;
    private readonly treeDataProvider: DeepnoteTreeDataProvider;

    private treeView: TreeView<DeepnoteTreeItem>;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(ILogger) logger: ILogger
    ) {
        this.logger = logger;
        this.treeDataProvider = new DeepnoteTreeDataProvider(logger);
    }

    public dispose(): void {
        this.treeView?.dispose();
        this.treeDataProvider.dispose();
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

    /**
     * Shared helper that creates a new notebook in a new sibling `.deepnote` file.
     * The new file shares the same project id/name/version/metadata as the source file
     * and contains only the newly-created notebook (plus the source's init notebook if any).
     * @param fileUri The URI of the source project file (not modified)
     * @returns Object with notebook ID and name if successful, or null if aborted/failed
     */
    public async createAndAddNotebookToProject(fileUri: Uri): Promise<{ id: string; name: string } | null> {
        // Read the Deepnote project file
        const sourceData = await readDeepnoteProjectFile(fileUri);

        if (!sourceData?.project) {
            await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
            return null;
        }

        // Aggregate notebook names across all sibling files sharing the same project ID
        const existingNames = await this.collectNotebookNamesForProject(sourceData.project.id);

        // Generate suggested name and prompt user
        const suggestedName = this.generateSuggestedNotebookName(existingNames);
        const notebookName = await this.promptForNotebookName(suggestedName, existingNames);

        if (!notebookName) {
            return null;
        }

        // Create new notebook with initial block
        const newNotebook = this.createNotebookWithFirstBlock(notebookName);

        // Build a single-notebook sibling file (preserves source project metadata and init notebook)
        const newProject = await buildSingleNotebookFile(sourceData, newNotebook);
        const newFileUri = await buildSiblingNotebookFileUri(fileUri, notebookName, async (u) => {
            try {
                await workspace.fs.stat(u);

                return true;
            } catch {
                return false;
            }
        });

        const yaml = serializeDeepnoteFile(newProject);

        await workspace.fs.writeFile(newFileUri, new TextEncoder().encode(yaml));

        // Refresh the tree view
        this.treeDataProvider.refresh();

        // Open the newly-created file
        const document = await workspace.openNotebookDocument(newFileUri);

        await window.showNotebookDocument(document, {
            preserveFocus: false,
            preview: false
        });

        return { id: newNotebook.id, name: notebookName };
    }

    public async renameNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        const target = this.resolveNotebookTarget(treeItem);

        if (!target) {
            return;
        }

        try {
            const { fileUri, notebookId } = target;
            const projectData = await readDeepnoteProjectFile(fileUri);
            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }
            const targetNotebook = projectData.project.notebooks.find((nb: DeepnoteNotebook) => nb.id === notebookId);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));
                return;
            }

            const currentName = targetNotebook.name;

            const existingNames = new Set(
                projectData.project.notebooks
                    .map((nb: DeepnoteNotebook) => nb.name)
                    .filter((name: string) => name !== currentName)
            );

            const newName = await this.promptForNotebookName(currentName, existingNames);

            if (!newName || newName === currentName) {
                return;
            }

            targetNotebook.name = newName;

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = serializeDeepnoteFile(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            await this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
            await window.showInformationMessage(l10n.t('Notebook renamed to: {0}', newName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename notebook: {0}', errorMessage));
        }
    }

    public async deleteNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        const target = this.resolveNotebookTarget(treeItem);

        if (!target) {
            return;
        }

        const { fileUri, notebookId } = target;
        const isSingleNotebookFile = treeItem.contextValue === NOTEBOOK_FILE_CONTEXT_VALUE;

        try {
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            const targetNotebook = projectData.project.notebooks.find((nb: DeepnoteNotebook) => nb.id === notebookId);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));
                return;
            }

            const notebookName = targetNotebook.name;

            const confirmation = await window.showWarningMessage(
                l10n.t('Are you sure you want to delete notebook "{0}"?', notebookName),
                { modal: true },
                l10n.t('Delete')
            );

            if (confirmation !== l10n.t('Delete')) {
                return;
            }

            // Single-notebook file: removing the sole notebook would leave an empty file; delete the file instead
            if (isSingleNotebookFile) {
                await workspace.fs.delete(fileUri);
                this.treeDataProvider.refresh();
                await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));
                return;
            }

            projectData.project.notebooks = projectData.project.notebooks.filter(
                (nb: DeepnoteNotebook) => nb.id !== notebookId
            );

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = serializeDeepnoteFile(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            await this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
            await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to delete notebook: {0}', errorMessage));
        }
    }

    public async duplicateNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        const target = this.resolveNotebookTarget(treeItem);

        if (!target) {
            return;
        }

        const { fileUri, notebookId } = target;
        const isSingleNotebookFile = treeItem.contextValue === NOTEBOOK_FILE_CONTEXT_VALUE;

        try {
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            const targetNotebook = projectData.project.notebooks.find((nb: DeepnoteNotebook) => nb.id === notebookId);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));
                return;
            }

            const originalName = targetNotebook.name;

            // For sibling-file duplicates we need to avoid name collisions across the whole project group,
            // not just within a single file — otherwise two siblings could end up with the same notebook name.
            const existingNames = isSingleNotebookFile
                ? await this.collectNotebookNamesForProject(projectData.project.id)
                : new Set(projectData.project.notebooks.map((nb: DeepnoteNotebook) => nb.name));

            let copyNumber = 1;
            let newName = `${originalName} (Copy)`;
            while (existingNames.has(newName)) {
                copyNumber++;
                newName = `${originalName} (Copy ${copyNumber})`;
            }

            const newNotebook = this.cloneNotebookWithFreshIds(targetNotebook, newName);

            if (isSingleNotebookFile) {
                // Build a sibling `.deepnote` so each single-notebook file carries exactly one notebook
                const newProject = await buildSingleNotebookFile(projectData, newNotebook);
                const newFileUri = await buildSiblingNotebookFileUri(fileUri, newName, async (u) => {
                    try {
                        await workspace.fs.stat(u);

                        return true;
                    } catch {
                        return false;
                    }
                });

                const yaml = serializeDeepnoteFile(newProject);

                await workspace.fs.writeFile(newFileUri, new TextEncoder().encode(yaml));

                this.treeDataProvider.refresh();

                const document = await workspace.openNotebookDocument(newFileUri);

                await window.showNotebookDocument(document, {
                    preserveFocus: false,
                    preview: false
                });

                await window.showInformationMessage(l10n.t('Notebook duplicated: {0}', newName));
                return;
            }

            projectData.project.notebooks.push(newNotebook);

            if (!projectData.metadata) {
                projectData.metadata = { createdAt: new Date().toISOString() };
            }
            projectData.metadata.modifiedAt = new Date().toISOString();

            const updatedYaml = serializeDeepnoteFile(projectData);
            const encoder = new TextEncoder();
            await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));

            await this.treeDataProvider.refreshNotebook(treeItem.context.projectId);

            // Open the duplicated notebook
            const document = await workspace.openNotebookDocument(fileUri);
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

    public async renameProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectGroup) {
            return;
        }

        const groupData = treeItem.data as ProjectGroupData;
        const currentName = groupData.projectName;

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
            // Mirror the new name across every sibling file in the group so siblings don't diverge
            for (const file of groupData.files) {
                const fileUri = Uri.file(file.filePath);
                const projectData = await readDeepnoteProjectFile(fileUri);

                if (!projectData?.project) {
                    this.logger.error(`Failed to parse Deepnote file during rename: ${file.filePath}`);
                    continue;
                }

                projectData.project.name = newName;

                if (!projectData.metadata) {
                    projectData.metadata = { createdAt: new Date().toISOString() };
                }
                projectData.metadata.modifiedAt = new Date().toISOString();

                const updatedYaml = serializeDeepnoteFile(projectData);
                const encoder = new TextEncoder();
                await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));
            }

            this.treeDataProvider.refresh();
            await window.showInformationMessage(l10n.t('Project renamed to: {0}', newName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename project: {0}', errorMessage));
        }
    }

    private registerCommands(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RefreshDeepnoteExplorer, () => this.refreshExplorer())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.OpenDeepnoteNotebook, (context: DeepnoteTreeItemContext) =>
                this.openNotebook(context)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.OpenDeepnoteFile, (treeItem: DeepnoteTreeItem) => this.openFile(treeItem))
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RevealInDeepnoteExplorer, () => this.revealActiveNotebook())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.NewProject, () => this.newProject())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ImportNotebook, () => this.importNotebook())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ImportJupyterNotebook, () => this.importJupyterNotebook())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.NewNotebook, () => this.newNotebook())
        );

        // Context menu commands for tree items
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RenameProject, (treeItem: DeepnoteTreeItem) =>
                this.renameProject(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.DeleteProject, (treeItem: DeepnoteTreeItem) =>
                this.deleteProject(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RenameNotebook, (treeItem: DeepnoteTreeItem) =>
                this.renameNotebook(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.DeleteNotebook, (treeItem: DeepnoteTreeItem) =>
                this.deleteNotebook(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.DuplicateNotebook, (treeItem: DeepnoteTreeItem) =>
                this.duplicateNotebook(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.AddNotebookToProject, (treeItem: DeepnoteTreeItem) =>
                this.addNotebookToProject(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ExportProject, (treeItem: DeepnoteTreeItem) =>
                this.exportProject(treeItem)
            )
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ExportNotebook, (treeItem: DeepnoteTreeItem) =>
                this.exportNotebook(treeItem)
            )
        );
    }

    /**
     * Deep-clones a notebook with a new id, freshly-generated block ids/blockGroups, and
     * reset `executionCount`. Used by duplicate flows so cached state keyed on
     * `(projectId, notebookId)` or on block identity can't collide across copies.
     */
    private cloneNotebookWithFreshIds(source: DeepnoteNotebook, newName: string): DeepnoteNotebook {
        return {
            ...source,
            id: uuidUtils.generateUuid(),
            name: newName,
            blocks: source.blocks.map((block: DeepnoteBlock) => {
                const clonedBlock =
                    typeof structuredClone !== 'undefined' ? structuredClone(block) : JSON.parse(JSON.stringify(block));

                clonedBlock.id = uuidUtils.generateUuid();
                clonedBlock.blockGroup = uuidUtils.generateUuid();
                clonedBlock.executionCount = undefined;

                return clonedBlock;
            })
        };
    }

    /**
     * Resolves a tree item to the `(fileUri, notebookId)` pair that notebook-level handlers operate on.
     * Accepts both legacy inner `Notebook` items and single-notebook `ProjectFile` items
     * (contextValue `notebookFile`). Returns undefined for any other tree item kind.
     */
    private resolveNotebookTarget(treeItem: DeepnoteTreeItem): { fileUri: Uri; notebookId: string } | undefined {
        if (treeItem.type === DeepnoteTreeItemType.Notebook) {
            if (!treeItem.context.notebookId) {
                return undefined;
            }

            return {
                fileUri: Uri.file(treeItem.context.filePath),
                notebookId: treeItem.context.notebookId
            };
        }

        if (
            treeItem.type === DeepnoteTreeItemType.ProjectFile &&
            treeItem.contextValue === NOTEBOOK_FILE_CONTEXT_VALUE
        ) {
            const project = treeItem.data as DeepnoteProject;
            const singleNotebook = getSingleNonInitNotebook(project);

            if (!singleNotebook) {
                return undefined;
            }

            return {
                fileUri: Uri.file(treeItem.context.filePath),
                notebookId: singleNotebook.id
            };
        }

        return undefined;
    }

    /**
     * Generates a suggested unique notebook name based on the set of existing notebook names
     * across the project group (i.e., all sibling files sharing the same project ID).
     * @param existingNames The set of already-taken notebook names
     * @returns A unique suggested notebook name
     */
    private generateSuggestedNotebookName(existingNames: Set<string>): string {
        let nextNumber = existingNames.size + 1;
        let suggestedName = `Notebook ${nextNumber}`;

        while (existingNames.has(suggestedName)) {
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
    private async promptForNotebookName(
        suggestedName: string,
        existingNames: Set<string>
    ): Promise<string | undefined> {
        return await window.showInputBox({
            prompt: l10n.t('Enter a name for the new notebook'),
            placeHolder: suggestedName,
            value: suggestedName,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Notebook name cannot be empty');
                }
                if (existingNames.has(value)) {
                    return l10n.t('A notebook with this name already exists');
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
        const notebookId = uuidUtils.generateUuid();
        const firstBlock: DeepnoteBlock = {
            blockGroup: uuidUtils.generateUuid(),
            content: '',
            executionCount: undefined,
            id: uuidUtils.generateUuid(),
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
     * Aggregates notebook names across all `.deepnote` files in the workspace whose
     * `project.id` matches the given project ID. Used for project-wide uniqueness validation.
     * @param projectId The project ID to match against
     * @returns Set of notebook names taken across the project group
     */
    private async collectNotebookNamesForProject(projectId: string): Promise<Set<string>> {
        const names = new Set<string>();
        const workspaceFolders = workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            return names;
        }

        for (const folder of workspaceFolders) {
            const pattern = new RelativePattern(folder, '**/*.deepnote');
            const files = await workspace.findFiles(pattern);
            const projectFiles = files.filter((file) => !file.path.endsWith(SNAPSHOT_FILE_SUFFIX));

            for (const file of projectFiles) {
                try {
                    const project = await readDeepnoteProjectFile(file);

                    if (project?.project?.id !== projectId) {
                        continue;
                    }

                    for (const notebook of project.project.notebooks ?? []) {
                        names.add(notebook.name);
                    }
                } catch {
                    // Skip files that fail to parse; uniqueness is best-effort across siblings
                }
            }
        }

        return names;
    }

    public refreshTree(): void {
        this.treeDataProvider.refresh();
    }

    private refreshExplorer(): void {
        this.treeDataProvider.refresh();
    }

    private async openNotebook(context: DeepnoteTreeItemContext): Promise<void> {
        console.log(`Opening notebook in project: ${context.projectId}.`);

        try {
            const fileUri = Uri.file(context.filePath);
            const document = await workspace.openNotebookDocument(fileUri);

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
            const treeItem = await this.treeDataProvider.findTreeItem(projectId);

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

            const projectId = uuidUtils.generateUuid();
            const notebookId = uuidUtils.generateUuid();

            const firstBlock: DeepnoteBlock = {
                blockGroup: uuidUtils.generateUuid(),
                content: '',
                executionCount: 0,
                id: uuidUtils.generateUuid(),
                metadata: {},
                outputs: [],
                sortingKey: '0',
                type: 'code',
                version: 1
            };

            const projectData: DeepnoteFile = {
                version: '1.0.0',
                metadata: {
                    createdAt: new Date().toISOString(),
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

            const yamlContent = serializeDeepnoteFile(projectData);
            const encoder = new TextEncoder();
            const contentBuffer = encoder.encode(yamlContent);

            await workspace.fs.writeFile(fileUri, contentBuffer);

            this.treeDataProvider.refresh();

            const document = await workspace.openNotebookDocument(fileUri);

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
        const fileUri = document.uri;

        try {
            // Use shared helper to create and add notebook
            const result = await this.createAndAddNotebookToProject(fileUri);

            if (result) {
                await window.showInformationMessage(l10n.t('Created new notebook: {0}', result.name));
            }
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

    private async deleteProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectGroup) {
            return;
        }

        const groupData = treeItem.data as ProjectGroupData;
        const projectName = groupData.projectName;

        const confirmation = await window.showWarningMessage(
            l10n.t('Are you sure you want to delete project "{0}"?', projectName),
            { modal: true },
            l10n.t('Delete')
        );

        if (confirmation !== l10n.t('Delete')) {
            return;
        }

        try {
            for (const file of groupData.files) {
                try {
                    await workspace.fs.delete(Uri.file(file.filePath));
                } catch (error) {
                    this.logger.error(`Failed to delete ${file.filePath}`, error);
                }
            }

            this.treeDataProvider.refresh();
            await window.showInformationMessage(l10n.t('Project deleted: {0}', projectName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to delete project: {0}', errorMessage));
        }
    }

    private async addNotebookToProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectGroup) {
            return;
        }

        const groupData = treeItem.data as ProjectGroupData;

        if (groupData.files.length === 0) {
            return;
        }

        try {
            // Use the first file in the group as the template source (project id/name/metadata carry over)
            const fileUri = Uri.file(groupData.files[0].filePath);

            const result = await this.createAndAddNotebookToProject(fileUri);

            if (result) {
                await window.showInformationMessage(l10n.t('Created new notebook: {0}', result.name));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));
        }
    }

    /**
     * Exports all notebooks from a Deepnote project group (across every sibling file) to Jupyter format.
     */
    private async exportProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectGroup) {
            return;
        }

        const groupData = treeItem.data as ProjectGroupData;

        try {
            const format = await window.showQuickPick([{ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }], {
                placeHolder: l10n.t('Select export format')
            });

            if (!format) {
                return;
            }

            const outputFolder = await window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: l10n.t('Export Here'),
                title: l10n.t('Select Export Location')
            });

            if (!outputFolder?.length) {
                return;
            }

            type JupyterNotebookEntry = { filename: string; notebook: unknown };
            const jupyterNotebooks: JupyterNotebookEntry[] = [];

            for (const file of groupData.files) {
                const fileUri = Uri.file(file.filePath);
                const projectData = await readDeepnoteProjectFile(fileUri);

                if (!projectData?.project) {
                    this.logger.error(`Failed to parse Deepnote file during export: ${file.filePath}`);
                    continue;
                }

                const perFile = convertDeepnoteToJupyterNotebooks(projectData);
                jupyterNotebooks.push(...perFile);
            }

            if (jupyterNotebooks.length === 0) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));
                return;
            }

            // Check for existing files before writing
            const existingFiles: string[] = [];
            for (const { filename } of jupyterNotebooks) {
                const outputPath = Uri.joinPath(outputFolder[0], filename);
                try {
                    await workspace.fs.stat(outputPath);
                    existingFiles.push(filename);
                } catch {
                    // File doesn't exist, safe to write
                }
            }

            if (existingFiles.length > 0) {
                const fileList = existingFiles.join(', ');
                const overwrite = l10n.t('Overwrite');
                const result = await window.showWarningMessage(
                    l10n.t('The following files already exist: {0}. Do you want to overwrite them?', fileList),
                    { modal: true },
                    overwrite
                );

                if (result !== overwrite) {
                    return;
                }
            }

            for (const { filename, notebook } of jupyterNotebooks) {
                const outputPath = Uri.joinPath(outputFolder[0], filename);

                await workspace.fs.writeFile(outputPath, new TextEncoder().encode(JSON.stringify(notebook, null, 2)));
            }

            const count = jupyterNotebooks.length;
            const message =
                count === 1
                    ? l10n.t('Exported 1 notebook successfully')
                    : l10n.t('Exported {0} notebooks successfully', count);

            await window.showInformationMessage(message);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to export: {0}', errorMessage));
        }
    }

    /**
     * Exports a single notebook (either a single-notebook file or a legacy inner notebook)
     * from a Deepnote project to Jupyter format.
     */
    private async exportNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        const target = this.resolveNotebookTarget(treeItem);

        if (!target) {
            return;
        }

        const { fileUri, notebookId } = target;

        try {
            const format = await window.showQuickPick([{ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }], {
                placeHolder: l10n.t('Select export format')
            });

            if (!format) {
                return;
            }

            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return;
            }

            const outputFolder = await window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: l10n.t('Export Here'),
                title: l10n.t('Select Export Location')
            });

            if (!outputFolder?.length) {
                return;
            }

            const targetNotebook = projectData.project.notebooks.find((nb) => nb.id === notebookId);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return;
            }

            const filteredProject = {
                ...projectData,
                project: {
                    ...projectData.project,
                    notebooks: [targetNotebook]
                }
            };

            const [notebookToExport] = convertDeepnoteToJupyterNotebooks(filteredProject);
            const outputPath = Uri.joinPath(outputFolder[0], notebookToExport.filename);

            let fileExists = false;
            try {
                await workspace.fs.stat(outputPath);
                fileExists = true;
            } catch {
                // File doesn't exist, safe to write
            }

            if (fileExists) {
                const overwrite = l10n.t('Overwrite');
                const result = await window.showWarningMessage(
                    l10n.t(
                        'A file named "{0}" already exists. Do you want to overwrite it?',
                        notebookToExport.filename
                    ),
                    { modal: true },
                    overwrite
                );

                if (result !== overwrite) {
                    return;
                }
            }

            await workspace.fs.writeFile(
                outputPath,
                new TextEncoder().encode(JSON.stringify(notebookToExport.notebook, null, 2))
            );

            await window.showInformationMessage(l10n.t('Exported 1 notebook successfully'));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to export: {0}', errorMessage));
        }
    }
}
