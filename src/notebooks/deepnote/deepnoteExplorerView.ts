import { injectable, inject } from 'inversify';
import { commands, window, workspace, type TreeView, RelativePattern, Uri, l10n } from 'vscode';
import { serializeDeepnoteFile, type DeepnoteBlock, type DeepnoteFile } from '@deepnote/blocks';
import { convertDeepnoteToJupyterNotebooks, convertIpynbFileToDeepnoteFile } from '@deepnote/convert';

import { ITelemetryService } from '../../platform/analytics/types';
import { IExtensionContext } from '../../platform/common/types';
import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
import {
    type DeepnoteTreeItem,
    DeepnoteTreeItemType,
    type DeepnoteTreeItemContext,
    getNonInitNotebooks,
    isSingleNotebookFile,
    resolveLeafNotebook
} from './deepnoteTreeItem';
import { uuidUtils } from '../../platform/common/uuid';
import { getFilePath } from '../../platform/common/platform/fs-paths';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { Commands } from '../../platform/common/constants';
import { flushNotebookDocumentIfDirty } from '../../platform/deepnote/deepnoteDocumentFlush';
import { readDeepnoteProjectFile } from '../../platform/deepnote/deepnoteProjectFileReader';
import { ILogger } from '../../platform/logging/types';
import { buildSingleNotebookFile, buildSiblingNotebookFileUri } from './deepnoteNotebookFileFactory';
import { deepnoteFileExists } from './deepnoteSiblingFileAllocator';
import { isSnapshotFile } from './snapshots/snapshotFiles';

/**
 * Manages the Deepnote explorer tree view and its commands. Sibling `.deepnote` files are grouped
 * by `project.id`; project-scoped commands span the group, notebook-scoped ones a single leaf/child.
 */

@injectable()
export class DeepnoteExplorerView {
    private treeView: TreeView<DeepnoteTreeItem>;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(ILogger) private readonly logger: ILogger,
        private readonly treeDataProvider: DeepnoteTreeDataProvider,
        private readonly analytics: ITelemetryService
    ) {}

    public activate(): void {
        this.treeView = window.createTreeView('deepnoteExplorer', {
            treeDataProvider: this.treeDataProvider,
            showCollapseAll: true
        });

        this.extensionContext.subscriptions.push(this.treeView);
        this.extensionContext.subscriptions.push(this.treeDataProvider);

        this.registerCommands();
    }

    /** Refreshes the full tree; exposed so outside callers (e.g. the splitter) needn't reach into the provider. */
    public refresh(): void {
        this.treeDataProvider.refresh();
    }

    /**
     * Collect the names of every non-init notebook across all sibling files of a project group,
     * for cross-group name uniqueness in rename/new/duplicate flows.
     * @param projectId The project group's id
     * @param excludeName Optional name to exclude (e.g. the notebook's current name when renaming)
     */
    public async collectNotebookNamesForProject(projectId: string, excludeName?: string): Promise<Set<string>> {
        const names = new Set<string>();

        for (const workspaceFolder of workspace.workspaceFolders || []) {
            let files: Uri[];

            try {
                files = await workspace.findFiles(new RelativePattern(workspaceFolder, '**/*.deepnote'));
            } catch (error) {
                this.logger.error('Failed to enumerate .deepnote files for name collection', error);

                continue;
            }

            for (const fileUri of files) {
                // Skip snapshot sidecars: they are full project clones whose stale notebook names
                // would otherwise pollute the uniqueness set.
                if (isSnapshotFile(fileUri)) {
                    continue;
                }

                try {
                    const projectData = await readDeepnoteProjectFile(fileUri);

                    if (projectData?.project?.id !== projectId) {
                        continue;
                    }

                    for (const notebook of getNonInitNotebooks(projectData)) {
                        if (notebook.name && notebook.name !== excludeName) {
                            names.add(notebook.name);
                        }
                    }
                } catch (error) {
                    this.logger.error(`Failed to read ${fileUri.path} for name collection`, error);
                }
            }
        }

        return names;
    }

    /**
     * Creates a new sibling `.deepnote` file with a single new notebook, then opens it.
     * Never appends to `project.notebooks`.
     * @param sourceUri A sibling file used as the source for project-level metadata
     * @param existingNames Notebook names already in use across the project group (for uniqueness)
     * @returns Object with notebook id and name if successful, or null if aborted/failed
     */
    public async createNotebookSiblingFile(
        sourceUri: Uri,
        existingNames: Set<string>
    ): Promise<{ id: string; name: string } | null> {
        const sourceProject = await readDeepnoteProjectFile(sourceUri);

        if (!sourceProject?.project) {
            await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

            return null;
        }

        const suggestedName = this.generateSuggestedNotebookName(existingNames);
        const notebookName = await this.promptForNotebookName(suggestedName, existingNames);

        if (!notebookName) {
            return null;
        }

        const newNotebook = this.createNotebookWithFirstBlock(notebookName);
        const newFile = buildSingleNotebookFile(sourceProject, newNotebook);
        const targetUri = await buildSiblingNotebookFileUri(
            sourceUri,
            sourceProject.project.name,
            notebookName,
            deepnoteFileExists
        );

        await this.writeAndOpenNotebookFile(targetUri, newFile);

        return { id: newNotebook.id, name: notebookName };
    }

    public async renameNotebook(treeItem: DeepnoteTreeItem): Promise<boolean> {
        if (!this.itemIsNotebookScoped(treeItem)) {
            return false;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return false;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return false;
            }

            const currentName = targetNotebook.name;
            const existingNames = await this.collectNotebookNamesForProject(treeItem.context.projectId, currentName);

            const newName = await this.promptForNotebookName(currentName, existingNames);

            if (!newName || newName === currentName) {
                return false;
            }

            // Flush the open document and re-read before rewriting, so we serialize the user's live cell
            // edits instead of clobbering them via the watcher reload; abort if the save is declined.
            if (!(await flushNotebookDocumentIfDirty(fileUri))) {
                await window.showErrorMessage(
                    l10n.t('Could not save "{0}" before renaming. The notebook was left unchanged.', currentName)
                );

                return false;
            }

            const freshData = await readDeepnoteProjectFile(fileUri);
            const freshTarget = this.resolveTargetNotebook(treeItem, freshData);

            if (!freshTarget) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return false;
            }

            freshTarget.name = newName;

            await this.writeProjectFile(fileUri, freshData);

            this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
            await window.showInformationMessage(l10n.t('Notebook renamed to: {0}', newName));

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename notebook: {0}', errorMessage));

            return false;
        }
    }

    public async deleteNotebook(treeItem: DeepnoteTreeItem): Promise<boolean> {
        if (!this.itemIsNotebookScoped(treeItem)) {
            return false;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return false;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return false;
            }

            const notebookName = targetNotebook.name;

            const confirmation = await window.showWarningMessage(
                l10n.t('Are you sure you want to delete notebook "{0}"?', notebookName),
                { modal: true },
                l10n.t('Delete')
            );

            if (confirmation !== l10n.t('Delete')) {
                return false;
            }

            // A single-notebook file's only non-init notebook is the file itself: delete the file.
            if (this.itemIsSingleNotebookFile(treeItem, projectData)) {
                await this.deleteNotebookFile(fileUri);
                this.treeDataProvider.refresh();
                await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));

                return true;
            }

            // Legacy multi-notebook file: remove the notebook from the array.
            projectData.project.notebooks = projectData.project.notebooks.filter(
                (nb: DeepnoteNotebook) => nb.id !== targetNotebook.id
            );

            await this.writeProjectFile(fileUri, projectData);

            this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
            await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to delete notebook: {0}', errorMessage));

            return false;
        }
    }

    /**
     * Deletes a `.deepnote` file, honouring `files.enableTrash` like VS Code's Explorer. The OS trash
     * isn't reliably available everywhere (headless CI, containers), so those environments set it false
     * for a dependency-free permanent delete.
     */
    private async deleteNotebookFile(fileUri: Uri): Promise<void> {
        const useTrash = workspace.getConfiguration('files').get<boolean>('enableTrash', true);
        await workspace.fs.delete(fileUri, { useTrash });
    }

    public async duplicateNotebook(treeItem: DeepnoteTreeItem): Promise<boolean> {
        if (!this.itemIsNotebookScoped(treeItem)) {
            return false;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return false;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return false;
            }

            const existingNames = await this.collectNotebookNamesForProject(treeItem.context.projectId);
            const newName = this.generateCopyName(targetNotebook.name, existingNames);
            const newNotebook = this.cloneNotebook(targetNotebook, newName);

            // Single-notebook file: the duplicate becomes a NEW SIBLING FILE.
            if (this.itemIsSingleNotebookFile(treeItem, projectData)) {
                const newFile = buildSingleNotebookFile(projectData, newNotebook);
                const targetUri = await buildSiblingNotebookFileUri(
                    fileUri,
                    projectData.project.name,
                    newName,
                    deepnoteFileExists
                );

                await this.writeAndOpenNotebookFile(targetUri, newFile);
                this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
                await window.showInformationMessage(l10n.t('Notebook duplicated: {0}', newName));

                return true;
            }

            // Legacy multi-notebook file: append the duplicate in place (existing behavior).
            projectData.project.notebooks.push(newNotebook);

            await this.writeProjectFile(fileUri, projectData);

            this.treeDataProvider.refreshNotebook(treeItem.context.projectId);

            const document = await workspace.openNotebookDocument(fileUri);
            await window.showNotebookDocument(document, {
                preserveFocus: false,
                preview: false
            });

            await window.showInformationMessage(l10n.t('Notebook duplicated: {0}', newName));

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to duplicate notebook: {0}', errorMessage));

            return false;
        }
    }

    public async renameProject(treeItem: DeepnoteTreeItem): Promise<boolean> {
        if (treeItem.extra.type !== DeepnoteTreeItemType.ProjectGroup) {
            return false;
        }

        const group = treeItem.extra.data;
        const currentName = group.projectName;

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
            return false;
        }

        try {
            // Flush open siblings with unsaved edits first, so the disk read-modify-write below can't
            // clobber live cell edits via the watcher reload; abort the whole rename if a save fails.
            for (const { filePath } of group.files) {
                const fileUri = Uri.file(filePath);

                if (!(await flushNotebookDocumentIfDirty(fileUri))) {
                    await window.showErrorMessage(
                        l10n.t(
                            'Could not save "{0}" before renaming. The project was left unchanged.',
                            fileUri.path.split('/').pop() ?? filePath
                        )
                    );

                    return false;
                }
            }

            let failedCount = 0;

            for (const { filePath } of group.files) {
                try {
                    const fileUri = Uri.file(filePath);
                    const projectData = await readDeepnoteProjectFile(fileUri);

                    if (!projectData?.project) {
                        continue;
                    }

                    projectData.project.name = newName;

                    await this.writeProjectFile(fileUri, projectData);
                } catch (error) {
                    failedCount++;
                    this.logger.error(`Failed to rename project file ${filePath}`, error);
                }
            }

            this.treeDataProvider.refresh();

            if (failedCount > 0) {
                await window.showWarningMessage(
                    l10n.t('Project renamed to "{0}", but {1} file(s) could not be updated.', newName, failedCount)
                );
            } else {
                await window.showInformationMessage(l10n.t('Project renamed to: {0}', newName));
            }

            return failedCount === 0;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename project: {0}', errorMessage));

            return false;
        }
    }

    private registerCommands(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RefreshDeepnoteExplorer, () => this.refreshExplorer())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.OpenDeepnoteNotebook, async (context: DeepnoteTreeItemContext) => {
                const completed = await this.openNotebook(context);
                this.analytics.trackEvent({ eventName: 'open_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.OpenDeepnoteFile, (treeItem: DeepnoteTreeItem) => this.openFile(treeItem))
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RevealInDeepnoteExplorer, () => this.revealActiveNotebook())
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.NewProject, async () => {
                const completed = await this.newProject();
                this.analytics.trackEvent({ eventName: 'create_project', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ImportNotebook, async () => {
                const completed = await this.importNotebook();
                this.analytics.trackEvent({ eventName: 'import_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ImportJupyterNotebook, async () => {
                const completed = await this.importJupyterNotebook();
                this.analytics.trackEvent({ eventName: 'import_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.NewNotebook, async () => {
                const completed = await this.newNotebook();
                this.analytics.trackEvent({ eventName: 'create_notebook', properties: { completed } });
            })
        );

        // Context menu commands for tree items
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RenameProject, async (treeItem: DeepnoteTreeItem) => {
                const completed = await this.renameProject(treeItem);
                this.analytics.trackEvent({ eventName: 'rename_project', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.RenameNotebook, async (treeItem: DeepnoteTreeItem) => {
                const completed = await this.renameNotebook(treeItem);
                this.analytics.trackEvent({ eventName: 'rename_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.DeleteNotebook, async (treeItem: DeepnoteTreeItem) => {
                const completed = await this.deleteNotebook(treeItem);
                this.analytics.trackEvent({ eventName: 'delete_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.DuplicateNotebook, async (treeItem: DeepnoteTreeItem) => {
                const completed = await this.duplicateNotebook(treeItem);
                this.analytics.trackEvent({ eventName: 'duplicate_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.AddNotebookToProject, async (treeItem: DeepnoteTreeItem) => {
                const completed = await this.addNotebookToProject(treeItem);
                this.analytics.trackEvent({ eventName: 'create_notebook', properties: { completed } });
            })
        );

        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ExportNotebook, async (treeItem: DeepnoteTreeItem) => {
                const completed = await this.exportNotebook(treeItem);
                this.analytics.trackEvent({
                    eventName: 'export_notebook',
                    properties: { completed, format: 'jupyter' }
                });
            })
        );
    }

    /**
     * Whether a tree item is notebook-scoped: a single-notebook leaf file (`ProjectFile`) or a
     * legacy in-file notebook child (`Notebook`).
     */
    private itemIsNotebookScoped(treeItem: DeepnoteTreeItem): boolean {
        return (
            treeItem.extra.type === DeepnoteTreeItemType.ProjectFile ||
            treeItem.extra.type === DeepnoteTreeItemType.Notebook
        );
    }

    /**
     * Resolve the notebook a notebook-scoped command targets: `context.notebookId` for a legacy
     * in-file child, otherwise the leaf file's notebook.
     */
    private resolveTargetNotebook(treeItem: DeepnoteTreeItem, projectData: DeepnoteFile): DeepnoteNotebook | undefined {
        if (treeItem.context.notebookId) {
            return projectData.project.notebooks?.find((nb: DeepnoteNotebook) => nb.id === treeItem.context.notebookId);
        }

        return resolveLeafNotebook(projectData);
    }

    /**
     * Whether the tree item targets a single-notebook leaf file, as opposed to a legacy
     * multi-notebook file's in-file child.
     */
    private itemIsSingleNotebookFile(treeItem: DeepnoteTreeItem, projectData: DeepnoteFile): boolean {
        if (treeItem.extra.type !== DeepnoteTreeItemType.ProjectFile) {
            return false;
        }

        return isSingleNotebookFile(projectData);
    }

    /** Generates a unique suggested notebook name given the names already in use. */
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
     * Generate a unique `(Copy)` name for a duplicated notebook.
     */
    private generateCopyName(originalName: string, existingNames: Set<string>): string {
        let copyNumber = 1;
        let newName = `${originalName} (Copy)`;

        while (existingNames.has(newName)) {
            copyNumber++;
            newName = `${originalName} (Copy ${copyNumber})`;
        }

        return newName;
    }

    /**
     * Deep clone a notebook with fresh ids and cleared execution state.
     */
    private cloneNotebook(source: DeepnoteNotebook, newName: string): DeepnoteNotebook {
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
     * Serializes a project file and writes it back to disk, stamping `modifiedAt`.
     */
    private async writeProjectFile(fileUri: Uri, projectData: DeepnoteFile): Promise<void> {
        if (!projectData.metadata) {
            projectData.metadata = { createdAt: new Date().toISOString() };
        }

        projectData.metadata.modifiedAt = new Date().toISOString();

        const updatedYaml = serializeDeepnoteFile(projectData);
        const encoder = new TextEncoder();

        await workspace.fs.writeFile(fileUri, encoder.encode(updatedYaml));
    }

    /**
     * Writes a new single-notebook file to disk, refreshes the tree, and opens it.
     */
    private async writeAndOpenNotebookFile(fileUri: Uri, projectData: DeepnoteFile): Promise<void> {
        const yamlContent = serializeDeepnoteFile(projectData);
        const encoder = new TextEncoder();

        await workspace.fs.writeFile(fileUri, encoder.encode(yamlContent));

        const document = await workspace.openNotebookDocument(fileUri);
        await window.showNotebookDocument(document, {
            preserveFocus: false,
            preview: false
        });
    }

    private refreshExplorer(): void {
        this.treeDataProvider.refresh();
    }

    private async openNotebook(context: DeepnoteTreeItemContext): Promise<boolean> {
        try {
            const fileUri = Uri.file(context.filePath);
            const document = await workspace.openNotebookDocument(fileUri);

            await window.showNotebookDocument(document, {
                preview: false,
                preserveFocus: false
            });

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(`Failed to open notebook: ${errorMessage}`);

            return false;
        }
    }

    private async openFile(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.extra.type !== DeepnoteTreeItemType.ProjectFile) {
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
            this.logger.error('Failed to reveal notebook in explorer', error);
            await window.showInformationMessage(
                `Active notebook: ${notebookMetadata?.deepnoteNotebookName || 'Untitled'} in project ${
                    notebookMetadata?.deepnoteProjectName || 'Untitled'
                }`
            );
        }
    }

    private async newProject(): Promise<boolean> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            const selection = await window.showInformationMessage(
                l10n.t('No workspace folder is open. Would you like to open a folder?'),
                l10n.t('Open Folder'),
                l10n.t('Cancel')
            );

            if (selection === l10n.t('Open Folder')) {
                await commands.executeCommand('vscode.openFolder');
            }

            return false;
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
            return false;
        }

        try {
            const workspaceFolder = workspace.workspaceFolders[0];
            const fileName = `${projectName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.deepnote`;
            const fileUri = Uri.joinPath(workspaceFolder.uri, fileName);

            // Check if file already exists
            try {
                await workspace.fs.stat(fileUri);
                await window.showErrorMessage(l10n.t('A file named "{0}" already exists in this workspace.', fileName));

                return false;
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

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(l10n.t(`Failed to create project: {0}`, errorMessage));

            return false;
        }
    }

    private async newNotebook(): Promise<boolean> {
        const activeEditor = window.activeNotebookEditor;

        if (!activeEditor || activeEditor.notebook.notebookType !== 'deepnote') {
            await window.showErrorMessage(l10n.t('No active Deepnote file opened. Please open a Deepnote file first.'));

            return false;
        }

        const document = activeEditor.notebook;
        const fileUri = document.uri;

        try {
            const projectId = document.metadata?.deepnoteProjectId as string | undefined;
            const existingNames = projectId ? await this.collectNotebookNamesForProject(projectId) : new Set<string>();

            const result = await this.createNotebookSiblingFile(fileUri, existingNames);

            if (result) {
                // Scoped refresh preserves expanded groups; a full `refresh()` would collapse the tree.
                if (projectId) {
                    this.treeDataProvider.refreshNotebook(projectId);
                } else {
                    this.treeDataProvider.refresh();
                }

                await window.showInformationMessage(l10n.t('Created new notebook: {0}', result.name));
            }

            return result !== null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));

            return false;
        }
    }

    private async checkJupyterImportTargetsAvailable(jupyterUris: readonly Uri[], folderUri: Uri): Promise<boolean> {
        // Guard against overwriting an existing file or two same-basename selections clobbering each other.
        const seenNames = new Set<string>();

        for (const jupyterUri of jupyterUris) {
            const { outputFileName, outputUri } = this.deepnoteTargetForJupyterUri(jupyterUri, folderUri);
            let exists = seenNames.has(outputFileName);

            if (!exists) {
                try {
                    await workspace.fs.stat(outputUri);
                    exists = true;
                } catch {
                    // No file at the target path — available.
                }
            }

            if (exists) {
                await window.showErrorMessage(
                    l10n.t('A file named "{0}" already exists in this workspace.', outputFileName)
                );

                return false;
            }

            seenNames.add(outputFileName);
        }

        return true;
    }

    private async convertJupyterUrisToDeepnoteFiles(jupyterUris: readonly Uri[], folderUri: Uri): Promise<number> {
        const failedNames: string[] = [];

        for (const jupyterUri of jupyterUris) {
            const { inputPath, outputFileName, outputUri, projectName } = this.deepnoteTargetForJupyterUri(
                jupyterUri,
                folderUri
            );

            try {
                await convertIpynbFileToDeepnoteFile(inputPath, {
                    outputPath: getFilePath(outputUri),
                    projectName
                });
            } catch (error) {
                failedNames.push(outputFileName);
                this.logger.error(`Failed to convert Jupyter notebook ${inputPath}`, error);
            }
        }

        if (failedNames.length > 0) {
            await window.showWarningMessage(
                l10n.t('Failed to import {0} notebook(s): {1}', failedNames.length, failedNames.join(', '))
            );
        }

        return failedNames.length;
    }

    private deepnoteTargetForJupyterUri(
        jupyterUri: Uri,
        folderUri: Uri
    ): { inputPath: string; outputFileName: string; outputUri: Uri; projectName: string } {
        const fileName = jupyterUri.path.split('/').pop() || 'notebook.ipynb';
        const projectName = fileName.replace(/\.ipynb$/i, '');
        const outputFileName = `${projectName}.deepnote`;

        return {
            inputPath: getFilePath(jupyterUri),
            outputFileName,
            outputUri: Uri.joinPath(folderUri, outputFileName),
            projectName
        };
    }

    private async importNotebook(): Promise<boolean> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            const selection = await window.showInformationMessage(
                l10n.t('No workspace folder is open. Would you like to open a folder?'),
                l10n.t('Open Folder'),
                l10n.t('Cancel')
            );

            if (selection === l10n.t('Open Folder')) {
                await commands.executeCommand('vscode.openFolder');
            }

            return false;
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
            return false;
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

                    return false;
                } catch {
                    // File doesn't exist, continue
                }
            }

            if (!(await this.checkJupyterImportTargetsAvailable(jupyterUris, workspaceFolder.uri))) {
                return false;
            }

            // Import deepnote files
            for (const deepnoteUri of deepnoteUris) {
                const fileName = deepnoteUri.path.split('/').pop() || 'imported.deepnote';
                const targetUri = Uri.joinPath(workspaceFolder.uri, fileName);

                const content = await workspace.fs.readFile(deepnoteUri);

                await workspace.fs.writeFile(targetUri, content);
            }

            const failedCount = await this.convertJupyterUrisToDeepnoteFiles(jupyterUris, workspaceFolder.uri);

            const numberOfNotebooks = jupyterUris.length + deepnoteUris.length - failedCount;

            if (numberOfNotebooks > 1) {
                await window.showInformationMessage(l10n.t('{0} notebooks imported successfully.', numberOfNotebooks));
            } else if (numberOfNotebooks === 1) {
                await window.showInformationMessage(l10n.t('Notebook imported successfully.'));
            }

            this.treeDataProvider.refresh();

            return numberOfNotebooks > 0;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(`Failed to import notebook: ${errorMessage}`);

            return false;
        }
    }

    private async importJupyterNotebook(): Promise<boolean> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            const selection = await window.showInformationMessage(
                l10n.t('No workspace folder is open. Would you like to open a folder?'),
                l10n.t('Open Folder'),
                l10n.t('Cancel')
            );

            if (selection === l10n.t('Open Folder')) {
                await commands.executeCommand('vscode.openFolder');
            }

            return false;
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
            return false;
        }

        try {
            const workspaceFolder = workspace.workspaceFolders[0];

            if (!(await this.checkJupyterImportTargetsAvailable(fileUris, workspaceFolder.uri))) {
                return false;
            }

            const failedCount = await this.convertJupyterUrisToDeepnoteFiles(fileUris, workspaceFolder.uri);

            const numberOfNotebooks = fileUris.length - failedCount;

            if (numberOfNotebooks > 1) {
                await window.showInformationMessage(
                    l10n.t('{0} Jupyter notebooks imported successfully.', numberOfNotebooks)
                );
            } else if (numberOfNotebooks === 1) {
                await window.showInformationMessage(l10n.t('Jupyter notebook imported successfully.'));
            }

            this.treeDataProvider.refresh();

            return numberOfNotebooks > 0;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            await window.showErrorMessage(l10n.t(`Failed to import Jupyter notebook: {0}`, errorMessage));

            return false;
        }
    }

    private async addNotebookToProject(treeItem: DeepnoteTreeItem): Promise<boolean> {
        if (treeItem.extra.type !== DeepnoteTreeItemType.ProjectGroup) {
            return false;
        }

        const group = treeItem.extra.data;
        const sourceFile = group.files[0];

        if (!sourceFile) {
            await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

            return false;
        }

        try {
            const existingNames = await this.collectNotebookNamesForProject(treeItem.context.projectId);
            const result = await this.createNotebookSiblingFile(Uri.file(sourceFile.filePath), existingNames);

            if (result) {
                // Scoped refresh (not `refresh()`): a full refresh resets the initial-scan flag, tearing the
                // whole tree down to a loading node and collapsing every expanded group.
                this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
                await window.showInformationMessage(l10n.t('Created new notebook: {0}', result.name));
            }

            return result !== null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));

            return false;
        }
    }

    /** Exports a single notebook (single-notebook leaf or legacy in-file notebook) to Jupyter. */
    private async exportNotebook(treeItem: DeepnoteTreeItem): Promise<boolean> {
        if (!this.itemIsNotebookScoped(treeItem)) {
            return false;
        }

        try {
            const format = await window.showQuickPick([{ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }], {
                placeHolder: l10n.t('Select export format')
            });

            if (!format) {
                return false;
            }

            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return false;
            }

            const outputFolder = await window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: l10n.t('Export Here'),
                title: l10n.t('Select Export Location')
            });

            if (!outputFolder?.length) {
                return false;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return false;
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
                    return false;
                }
            }

            await workspace.fs.writeFile(
                outputPath,
                new TextEncoder().encode(JSON.stringify(notebookToExport.notebook, null, 2))
            );

            await window.showInformationMessage(l10n.t('Exported 1 notebook successfully'));

            return true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to export: {0}', errorMessage));

            return false;
        }
    }
}
