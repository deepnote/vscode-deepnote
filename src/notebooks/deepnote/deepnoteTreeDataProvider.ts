import {
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Event,
    EventEmitter,
    workspace,
    RelativePattern,
    Uri,
    FileSystemWatcher,
    ThemeIcon,
    commands,
    l10n
} from 'vscode';

import {
    DeepnoteTreeItem,
    DeepnoteTreeItemType,
    DeepnoteTreeItemContext,
    type ProjectGroupData
} from './deepnoteTreeItem';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { readDeepnoteProjectFile } from './deepnoteProjectUtils';
import { ILogger } from '../../platform/logging/types';
import { isSnapshotFile, SNAPSHOT_FILE_SUFFIX } from './snapshots/snapshotFiles';

/**
 * Comparator function for sorting tree items alphabetically by label (case-insensitive)
 */
export function compareTreeItemsByLabel(a: DeepnoteTreeItem, b: DeepnoteTreeItem): number {
    const labelA = typeof a.label === 'string' ? a.label : '';
    const labelB = typeof b.label === 'string' ? b.label : '';
    return labelA.toLowerCase().localeCompare(labelB.toLowerCase());
}

/**
 * Loaded project file data
 */
interface LoadedProjectFile {
    filePath: string;
    project: DeepnoteProject;
}

/**
 * Tree data provider for the Deepnote explorer view.
 * Groups files by project ID, showing project groups at the top level.
 */
export class DeepnoteTreeDataProvider implements TreeDataProvider<DeepnoteTreeItem> {
    private _onDidChangeTreeData: EventEmitter<DeepnoteTreeItem | undefined | null | void> = new EventEmitter<
        DeepnoteTreeItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: Event<DeepnoteTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private fileWatcher: FileSystemWatcher | undefined;
    private cachedProjects: Map<string, DeepnoteProject> = new Map();
    private treeItemCache: Map<string, DeepnoteTreeItem> = new Map();
    private isInitialScanComplete: boolean = false;
    private initialScanPromise: Promise<void> | undefined;
    private readonly logger?: ILogger;

    constructor(logger?: ILogger) {
        this.logger = logger;
        this.setupFileWatcher();
        this.updateContextKey();
    }

    public dispose(): void {
        this.fileWatcher?.dispose();
        this._onDidChangeTreeData.dispose();
    }

    public refresh(): void {
        this.cachedProjects.clear();
        this.treeItemCache.clear();
        this.isInitialScanComplete = false;
        this.initialScanPromise = undefined;
        this.updateContextKey();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Refresh a specific project file in the tree
     */
    public async refreshProject(filePath: string): Promise<void> {
        this.cachedProjects.delete(filePath);
        // Full refresh since project grouping may have changed
        this._onDidChangeTreeData.fire();
    }

    /**
     * Refresh notebooks for a specific project
     */
    public async refreshNotebook(projectId: string): Promise<void> {
        // Clear all cached projects that match this project ID to force reload
        for (const [path, project] of this.cachedProjects.entries()) {
            if (project.project.id === projectId) {
                this.cachedProjects.delete(path);
            }
        }
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: DeepnoteTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        if (element) {
            if (element.type === DeepnoteTreeItemType.ProjectGroup) {
                return this.getFilesForProjectGroup(element);
            }

            if (element.type === DeepnoteTreeItemType.ProjectFile) {
                return this.getNotebooksForProject(element);
            }

            return [];
        }

        // Root level
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            return [];
        }

        if (!this.isInitialScanComplete) {
            if (!this.initialScanPromise) {
                this.initialScanPromise = this.performInitialScan();
            }

            return [this.createLoadingTreeItem()];
        }

        return this.getProjectGroups();
    }

    private createLoadingTreeItem(): DeepnoteTreeItem {
        const loadingItem = new DeepnoteTreeItem(
            DeepnoteTreeItemType.Loading,
            { filePath: '', projectId: '' },
            null,
            TreeItemCollapsibleState.None
        );
        loadingItem.label = l10n.t('Scanning for Deepnote projects...');
        loadingItem.iconPath = new ThemeIcon('loading~spin');
        return loadingItem;
    }

    private async performInitialScan(): Promise<void> {
        try {
            await this.loadAllProjectFiles();
        } finally {
            this.isInitialScanComplete = true;
            this.initialScanPromise = undefined;
            this.updateContextKey();
            this._onDidChangeTreeData.fire();
        }
    }

    /**
     * Load all .deepnote project files from the workspace
     */
    private async loadAllProjectFiles(): Promise<LoadedProjectFile[]> {
        const results: LoadedProjectFile[] = [];

        for (const workspaceFolder of workspace.workspaceFolders || []) {
            const pattern = new RelativePattern(workspaceFolder, '**/*.deepnote');
            const files = await workspace.findFiles(pattern);
            const projectFiles = files.filter((file) => !file.path.endsWith(SNAPSHOT_FILE_SUFFIX));

            for (const file of projectFiles) {
                try {
                    const project = await this.loadDeepnoteProject(file);

                    if (project) {
                        results.push({ filePath: file.path, project });
                    }
                } catch (error) {
                    this.logger?.error(`Failed to load Deepnote project from ${file.path}`, error);
                }
            }
        }

        return results;
    }

    /**
     * Get top-level project groups (grouped by project ID)
     */
    private async getProjectGroups(): Promise<DeepnoteTreeItem[]> {
        const allFiles = await this.loadAllProjectFiles();

        // Group by project ID
        const groupsByProjectId = new Map<string, LoadedProjectFile[]>();

        for (const file of allFiles) {
            const projectId = file.project.project.id;
            const existing = groupsByProjectId.get(projectId) ?? [];
            existing.push(file);
            groupsByProjectId.set(projectId, existing);
        }

        const groups: DeepnoteTreeItem[] = [];

        for (const [projectId, files] of groupsByProjectId.entries()) {
            const projectName = files[0].project.project.name;

            const groupData: ProjectGroupData = {
                projectId,
                projectName,
                files: files.map((f) => ({ filePath: f.filePath, project: f.project }))
            };

            const context: DeepnoteTreeItemContext = {
                filePath: files[0].filePath,
                projectId
            };

            // Expand single-file groups by default so the lone notebook stays visible
            const collapsibleState =
                files.length === 1 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed;

            const groupItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectGroup,
                context,
                groupData,
                collapsibleState
            );
            groups.push(groupItem);
        }

        groups.sort(compareTreeItemsByLabel);

        return groups;
    }

    /**
     * Get file items for a project group
     */
    private getFilesForProjectGroup(groupItem: DeepnoteTreeItem): DeepnoteTreeItem[] {
        const groupData = groupItem.data as ProjectGroupData;
        const fileItems: DeepnoteTreeItem[] = [];

        for (const file of groupData.files) {
            const initNotebookId = file.project.project.initNotebookId;
            const nonInitNotebooks = file.project.project.notebooks?.filter((nb) => nb.id !== initNotebookId) ?? [];
            const hasMultipleNotebooks = nonInitNotebooks.length > 1;

            const context: DeepnoteTreeItemContext = {
                filePath: file.filePath,
                projectId: groupData.projectId
            };

            const treeItem = new DeepnoteTreeItem(
                DeepnoteTreeItemType.ProjectFile,
                context,
                file.project,
                hasMultipleNotebooks ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None
            );
            fileItems.push(treeItem);
        }

        fileItems.sort(compareTreeItemsByLabel);

        return fileItems;
    }

    /**
     * Get notebook items for a project file (shown for multi-notebook files before splitting)
     */
    private getNotebooksForProject(projectItem: DeepnoteTreeItem): DeepnoteTreeItem[] {
        const project = projectItem.data as DeepnoteProject;
        const notebooks = project.project.notebooks || [];

        return notebooks.map((notebook: DeepnoteNotebook) => {
            const context: DeepnoteTreeItemContext = {
                filePath: projectItem.context.filePath,
                projectId: projectItem.context.projectId,
                notebookId: notebook.id
            };

            return new DeepnoteTreeItem(
                DeepnoteTreeItemType.Notebook,
                context,
                notebook,
                TreeItemCollapsibleState.None
            );
        });
    }

    private async loadDeepnoteProject(fileUri: Uri): Promise<DeepnoteProject | undefined> {
        const filePath = fileUri.path;

        const cached = this.cachedProjects.get(filePath);
        if (cached) {
            return cached;
        }

        try {
            const project = await readDeepnoteProjectFile(fileUri);

            if (project && project.project && project.project.id) {
                this.cachedProjects.set(filePath, project);
                return project;
            }
        } catch (error) {
            this.logger?.error(`Failed to parse Deepnote file ${filePath}`, error);
        }

        return undefined;
    }

    private setupFileWatcher(): void {
        if (!workspace.workspaceFolders) {
            return;
        }

        const pattern = '**/*.deepnote';
        this.fileWatcher = workspace.createFileSystemWatcher(pattern);

        if (!this.fileWatcher) {
            return;
        }

        this.fileWatcher.onDidChange((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }
            void this.refreshProject(uri.path);
        });

        this.fileWatcher.onDidCreate((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }
            this._onDidChangeTreeData.fire();
        });

        this.fileWatcher.onDidDelete((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }
            this.cachedProjects.delete(uri.path);
            this.treeItemCache.delete(`project:${uri.path}`);
            this._onDidChangeTreeData.fire();
        });
    }

    /**
     * Find a tree item by project ID
     */
    public async findTreeItem(projectId: string): Promise<DeepnoteTreeItem | undefined> {
        const groups = await this.getProjectGroups();

        for (const item of groups) {
            if (item.context.projectId === projectId) {
                return item;
            }
        }

        return undefined;
    }

    private updateContextKey(): void {
        void commands.executeCommand('setContext', 'deepnote.explorerInitialScanComplete', this.isInitialScanComplete);
    }
}
