import { injectable, inject } from 'inversify';
import { commands, window, workspace, type TreeView, RelativePattern, Uri, l10n } from 'vscode';
import { serializeDeepnoteFile, type DeepnoteBlock, type DeepnoteFile } from '@deepnote/blocks';
import { convertDeepnoteToJupyterNotebooks, convertIpynbFileToDeepnoteFile } from '@deepnote/convert';

import { IExtensionContext } from '../../platform/common/types';
import { DeepnoteTreeDataProvider } from './deepnoteTreeDataProvider';
import {
    type DeepnoteTreeItem,
    DeepnoteTreeItemType,
    type DeepnoteTreeItemContext,
    type ProjectGroupData,
    getNonInitNotebooks
} from './deepnoteTreeItem';
import { uuidUtils } from '../../platform/common/uuid';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { Commands } from '../../platform/common/constants';
import { readDeepnoteProjectFile } from './deepnoteProjectUtils';
import { ILogger } from '../../platform/logging/types';
import { buildSingleNotebookFile, buildSiblingNotebookFileUri } from './deepnoteNotebookFileFactory';
import { deepnoteFileExists } from './deepnoteSiblingFileAllocator';
import { isSnapshotFile } from './snapshots/snapshotFiles';

/**
 * Manages the Deepnote explorer tree view and related commands.
 *
 * Under single-notebook-per-file, the tree groups sibling `.deepnote` files by `project.id`.
 * Project-scoped commands (rename/delete/export project, add notebook) operate over EVERY sibling
 * file in the group; notebook-scoped commands operate on a single file (single-notebook leaf) or a
 * legacy in-file notebook child. New/duplicated notebooks become NEW SIBLING FILES via the factory.
 */

@injectable()
export class DeepnoteExplorerView {
    private readonly treeDataProvider: DeepnoteTreeDataProvider;

    private treeView: TreeView<DeepnoteTreeItem>;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(ILogger) private readonly logger: ILogger
    ) {
        this.treeDataProvider = new DeepnoteTreeDataProvider(logger);
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
     * Refreshes the full Deepnote explorer tree.
     * Exposed so callers outside the explorer (e.g. the multi-notebook splitter) can
     * trigger a refresh without reaching into the private tree data provider.
     */
    public refresh(): void {
        this.treeDataProvider.refresh();
    }

    /**
     * Creates a new sibling `.deepnote` file containing a single new notebook, derived from a source
     * project file, then opens it. Never appends to `project.notebooks`.
     * @param sourceUri The URI of a sibling file used as the source for project-level metadata
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
        const targetUri = await buildSiblingNotebookFileUri(sourceUri, notebookName, deepnoteFileExists);

        await this.writeAndOpenNotebookFile(targetUri, newFile);

        return { id: newNotebook.id, name: notebookName };
    }

    public async renameNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (!this.isNotebookScoped(treeItem)) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return;
            }

            const currentName = targetNotebook.name;
            const existingNames = await this.collectNotebookNamesForProject(treeItem.context.projectId, currentName);

            const newName = await this.promptForNotebookName(currentName, existingNames);

            if (!newName || newName === currentName) {
                return;
            }

            targetNotebook.name = newName;

            await this.writeProjectFile(fileUri, projectData);

            this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
            await window.showInformationMessage(l10n.t('Notebook renamed to: {0}', newName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to rename notebook: {0}', errorMessage));
        }
    }

    public async deleteNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (!this.isNotebookScoped(treeItem)) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

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

            // A single-notebook file's only non-init notebook is the file itself: delete the file.
            if (this.isSingleNotebookFile(treeItem, projectData)) {
                await this.deleteNotebookFile(fileUri);
                this.treeDataProvider.refresh();
                await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));

                return;
            }

            // Legacy multi-notebook file: remove the notebook from the array.
            projectData.project.notebooks = projectData.project.notebooks.filter(
                (nb: DeepnoteNotebook) => nb.id !== targetNotebook.id
            );

            await this.writeProjectFile(fileUri, projectData);

            this.treeDataProvider.refreshNotebook(treeItem.context.projectId);
            await window.showInformationMessage(l10n.t('Notebook deleted: {0}', notebookName));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to delete notebook: {0}', errorMessage));
        }
    }

    /**
     * Deletes a `.deepnote` file, honouring the user's `files.enableTrash` setting exactly as VS Code's
     * own Explorer does: move to the OS trash when enabled (recoverable), delete permanently when
     * disabled. The OS trash is not reliably available everywhere (headless CI, containers, filesystems
     * with no freedesktop trash spec, where the operation can hang or fail), so environments without it —
     * including the E2E suite — set `files.enableTrash` to false and get a dependency-free permanent delete.
     */
    private async deleteNotebookFile(fileUri: Uri): Promise<void> {
        const useTrash = workspace.getConfiguration('files').get<boolean>('enableTrash', true);
        await workspace.fs.delete(fileUri, { useTrash });
    }

    public async duplicateNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (!this.isNotebookScoped(treeItem)) {
            return;
        }

        try {
            const fileUri = Uri.file(treeItem.context.filePath);
            const projectData = await readDeepnoteProjectFile(fileUri);

            if (!projectData?.project?.notebooks) {
                await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

                return;
            }

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

            if (!targetNotebook) {
                await window.showErrorMessage(l10n.t('Notebook not found'));

                return;
            }

            const existingNames = await this.collectNotebookNamesForProject(treeItem.context.projectId);
            const newName = this.generateCopyName(targetNotebook.name, existingNames);
            const newNotebook = this.cloneNotebook(targetNotebook, newName);

            // Single-notebook file: the duplicate becomes a NEW SIBLING FILE.
            if (this.isSingleNotebookFile(treeItem, projectData)) {
                const newFile = buildSingleNotebookFile(projectData, newNotebook);
                const targetUri = await buildSiblingNotebookFileUri(fileUri, newName, deepnoteFileExists);

                await this.writeAndOpenNotebookFile(targetUri, newFile);
                this.treeDataProvider.refresh();
                await window.showInformationMessage(l10n.t('Notebook duplicated: {0}', newName));

                return;
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
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to duplicate notebook: {0}', errorMessage));
        }
    }

    public async renameProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectGroup) {
            return;
        }

        const group = treeItem.data as ProjectGroupData;
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
            return;
        }

        try {
            // Rename each sibling .deepnote file in the project group.
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
                    this.logger.error(`Failed to rename project file ${filePath}`, error);
                }
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
            commands.registerCommand(Commands.ExportNotebook, (treeItem: DeepnoteTreeItem) =>
                this.exportNotebook(treeItem)
            )
        );
    }

    /**
     * Whether a tree item is notebook-scoped: a single-notebook leaf file (`ProjectFile`) or a
     * legacy in-file notebook child (`Notebook`).
     */
    private isNotebookScoped(treeItem: DeepnoteTreeItem): boolean {
        return treeItem.type === DeepnoteTreeItemType.ProjectFile || treeItem.type === DeepnoteTreeItemType.Notebook;
    }

    /**
     * Whether the tree item targets a single-notebook file (the file holds exactly one non-init
     * notebook), as opposed to a legacy multi-notebook file's in-file child.
     */
    private isSingleNotebookFile(treeItem: DeepnoteTreeItem, projectData: DeepnoteFile): boolean {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectFile) {
            return false;
        }

        return getNonInitNotebooks(projectData).length === 1;
    }

    /**
     * Resolve the notebook a notebook-scoped command targets. For a legacy `Notebook` child the
     * `context.notebookId` selects it; for a single-notebook leaf file it is the file's only
     * non-init notebook.
     */
    private resolveTargetNotebook(treeItem: DeepnoteTreeItem, projectData: DeepnoteFile): DeepnoteNotebook | undefined {
        if (treeItem.context.notebookId) {
            return projectData.project.notebooks?.find((nb: DeepnoteNotebook) => nb.id === treeItem.context.notebookId);
        }

        return getNonInitNotebooks(projectData)[0];
    }

    /**
     * Collect the names of every non-init notebook across all sibling files of a project group,
     * for cross-group name uniqueness in rename/new/duplicate flows.
     * @param projectId The project group's id
     * @param excludeName Optional name to exclude (e.g. the notebook's current name when renaming)
     */
    private async collectNotebookNamesForProject(projectId: string, excludeName?: string): Promise<Set<string>> {
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
                // Skip snapshot sidecars (`*.snapshot.deepnote`): they are full project clones, so
                // their stale notebook names would otherwise pollute the uniqueness set. The tree
                // provider filters them the same way.
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
     * Generates a suggested unique notebook name based on existing names in the project group.
     * @param existingNames Names already in use across the project group
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
     * Prompts the user for a notebook name with validation.
     * @param suggestedName The default suggested name
     * @param existingNames Names already in use (rejected as duplicates)
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
     * Creates a new notebook with an initial empty code block.
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

    private async openNotebook(context: DeepnoteTreeItemContext): Promise<void> {
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
            const projectId = document.metadata?.deepnoteProjectId as string | undefined;
            const existingNames = projectId ? await this.collectNotebookNamesForProject(projectId) : new Set<string>();

            const result = await this.createNotebookSiblingFile(fileUri, existingNames);

            if (result) {
                this.treeDataProvider.refresh();
                await window.showInformationMessage(l10n.t('Created new notebook: {0}', result.name));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));
        }
    }

    private async checkJupyterImportTargetsAvailable(jupyterUris: readonly Uri[], folderUri: Uri): Promise<boolean> {
        // Each Jupyter notebook imports into its own .deepnote sibling; don't overwrite an existing
        // file or let two selected notebooks with the same base name clobber each other.
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

    private async convertJupyterUrisToDeepnoteFiles(jupyterUris: readonly Uri[], folderUri: Uri): Promise<void> {
        // Each Jupyter notebook becomes its own single-notebook .deepnote file.
        for (const jupyterUri of jupyterUris) {
            const { inputPath, outputUri, projectName } = this.deepnoteTargetForJupyterUri(jupyterUri, folderUri);

            await convertIpynbFileToDeepnoteFile(inputPath, {
                outputPath: outputUri.path,
                projectName
            });
        }
    }

    private deepnoteTargetForJupyterUri(
        jupyterUri: Uri,
        folderUri: Uri
    ): { inputPath: string; outputFileName: string; outputUri: Uri; projectName: string } {
        const fileName = jupyterUri.path.split('/').pop() || 'notebook.ipynb';
        const projectName = fileName.replace(/\.ipynb$/i, '');
        const outputFileName = `${projectName}.deepnote`;

        return {
            inputPath: jupyterUri.path,
            outputFileName,
            outputUri: Uri.joinPath(folderUri, outputFileName),
            projectName
        };
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

            // Check that each Jupyter import target is available (one .deepnote per notebook).
            if (!(await this.checkJupyterImportTargetsAvailable(jupyterUris, workspaceFolder.uri))) {
                return;
            }

            // Import deepnote files
            for (const deepnoteUri of deepnoteUris) {
                const fileName = deepnoteUri.path.split('/').pop() || 'imported.deepnote';
                const targetUri = Uri.joinPath(workspaceFolder.uri, fileName);

                const content = await workspace.fs.readFile(deepnoteUri);

                await workspace.fs.writeFile(targetUri, content);
            }

            // Convert jupyter files — each becomes its own single-notebook .deepnote file.
            await this.convertJupyterUrisToDeepnoteFiles(jupyterUris, workspaceFolder.uri);

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

            // Each Jupyter notebook becomes its own single-notebook .deepnote file.
            if (!(await this.checkJupyterImportTargetsAvailable(fileUris, workspaceFolder.uri))) {
                return;
            }

            await this.convertJupyterUrisToDeepnoteFiles(fileUris, workspaceFolder.uri);

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

    private async addNotebookToProject(treeItem: DeepnoteTreeItem): Promise<void> {
        if (treeItem.type !== DeepnoteTreeItemType.ProjectGroup) {
            return;
        }

        const group = treeItem.data as ProjectGroupData;
        const sourceFile = group.files[0];

        if (!sourceFile) {
            await window.showErrorMessage(l10n.t('Invalid Deepnote file format'));

            return;
        }

        try {
            const existingNames = await this.collectNotebookNamesForProject(treeItem.context.projectId);
            const result = await this.createNotebookSiblingFile(Uri.file(sourceFile.filePath), existingNames);

            if (result) {
                this.treeDataProvider.refresh();
                await window.showInformationMessage(l10n.t('Created new notebook: {0}', result.name));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await window.showErrorMessage(l10n.t('Failed to add notebook: {0}', errorMessage));
        }
    }

    /**
     * Exports a single notebook (single-notebook leaf file or legacy in-file notebook) to Jupyter.
     * @param treeItem The tree item representing a notebook
     */
    private async exportNotebook(treeItem: DeepnoteTreeItem): Promise<void> {
        if (!this.isNotebookScoped(treeItem)) {
            return;
        }

        try {
            const format = await window.showQuickPick([{ label: 'Jupyter Notebook (.ipynb)', value: 'jupyter' }], {
                placeHolder: l10n.t('Select export format')
            });

            if (!format) {
                return;
            }

            const fileUri = Uri.file(treeItem.context.filePath);
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

            const targetNotebook = this.resolveTargetNotebook(treeItem, projectData);

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
