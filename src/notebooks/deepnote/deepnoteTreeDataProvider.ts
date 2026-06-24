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
    ProjectGroupData,
    getNonInitNotebooks
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
 * Tree data provider for the Deepnote explorer view.
 *
 * The tree is grouped by `project.id`: root → `ProjectGroup` (one per distinct project id) →
 * `ProjectFile` (one per sibling file) → `Notebook` (legacy multi-notebook files only).
 *
 * `cachedProjects` is keyed by **file path**; the `ProjectGroup` layer is re-derived from that
 * cache on every read (group membership is "files whose `project.id` matches"). Because sibling
 * files deliberately share one `project.id`, every refresh fires a full-tree change rather than a
 * per-item scoped change.
 */
export class DeepnoteTreeDataProvider implements TreeDataProvider<DeepnoteTreeItem> {
    private _onDidChangeTreeData: EventEmitter<DeepnoteTreeItem | undefined | null | void> = new EventEmitter<
        DeepnoteTreeItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: Event<DeepnoteTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private fileWatcher: FileSystemWatcher | undefined;
    private cachedProjects: Map<string /* filePath */, DeepnoteProject> = new Map();
    private groupItemCache: Map<string /* projectId */, DeepnoteTreeItem> = new Map();
    private fileItemCache: Map<string /* filePath */, DeepnoteTreeItem> = new Map();
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
        this.groupItemCache.clear();
        this.fileItemCache.clear();
        this.isInitialScanComplete = false;
        this.initialScanPromise = undefined;
        this.updateContextKey();
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Refresh a single project file in the tree by evicting its cache entry and firing a full-tree
     * change. A full-tree fire (not a scoped `fire(item)`) is required because adding/removing/
     * renaming one file can move it between groups or change a group's collapse state/label.
     * @param filePath The path to the project file to refresh
     */
    public refreshProject(filePath: string): void {
        this.cachedProjects.delete(filePath);
        this.fileItemCache.delete(filePath);
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Refresh every sibling file of a project by evicting ALL `cachedProjects` entries whose
     * `project.id` matches, then firing a full-tree change. Iterating all entries (never breaking
     * on the first match) keeps the whole project group consistent when one sibling's notebook is
     * renamed/deleted/duplicated.
     * @param projectId The project ID whose sibling files should be refreshed
     */
    public refreshNotebook(projectId: string): void {
        for (const [filePath, project] of this.cachedProjects) {
            if (project.project.id === projectId) {
                this.cachedProjects.delete(filePath);
                this.fileItemCache.delete(filePath);
            }
        }

        this.groupItemCache.delete(projectId);
        this._onDidChangeTreeData.fire(undefined);
    }

    public getTreeItem(element: DeepnoteTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        if (element) {
            if (element.type === DeepnoteTreeItemType.ProjectGroup) {
                return this.getFilesForGroup(element);
            }

            if (element.type === DeepnoteTreeItemType.ProjectFile) {
                return this.getNotebooksForProjectFile(element);
            }

            return [];
        }

        // For root level, we need workspace folders
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

    /**
     * Find a tree item by project ID and optional notebook ID.
     * Returns the project group when no notebook id is given; otherwise the matching file/notebook.
     */
    public async findTreeItem(projectId: string, notebookId?: string): Promise<DeepnoteTreeItem | undefined> {
        const groups = await this.getProjectGroups();

        for (const group of groups) {
            if (group.context.projectId !== projectId) {
                continue;
            }

            if (!notebookId) {
                return group;
            }

            const files = await this.getFilesForGroup(group);

            for (const fileItem of files) {
                if (fileItem.context.notebookId === notebookId) {
                    return fileItem;
                }

                const notebooks = await this.getNotebooksForProjectFile(fileItem);
                const match = notebooks.find((notebookItem) => notebookItem.context.notebookId === notebookId);

                if (match) {
                    return match;
                }
            }

            return group;
        }

        return undefined;
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
            await this.loadAllProjects();
        } finally {
            this.isInitialScanComplete = true;
            this.initialScanPromise = undefined;
            this.updateContextKey();
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    /**
     * Build the root-level `ProjectGroup` nodes: one per distinct `project.id` across all
     * `.deepnote` files, sorted by project name. Single-file groups are expanded; multi-file
     * groups are collapsed.
     */
    private async getProjectGroups(): Promise<DeepnoteTreeItem[]> {
        const projectsByPath = await this.loadAllProjects();
        const groups = this.buildProjectGroups(projectsByPath);

        const groupItems: DeepnoteTreeItem[] = [];

        for (const group of groups) {
            const collapsibleState =
                group.files.length > 1 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.Expanded;

            let groupItem = this.groupItemCache.get(group.projectId);

            if (groupItem) {
                groupItem.data = group;
                groupItem.collapsibleState = collapsibleState;
                groupItem.updateVisualFields();
            } else {
                groupItem = new DeepnoteTreeItem(
                    DeepnoteTreeItemType.ProjectGroup,
                    { filePath: group.files[0]?.filePath ?? '', projectId: group.projectId },
                    group,
                    collapsibleState
                );
                this.groupItemCache.set(group.projectId, groupItem);
            }

            groupItems.push(groupItem);
        }

        groupItems.sort(compareTreeItemsByLabel);

        return groupItems;
    }

    /**
     * Group the cached file→project entries by `project.id` into `ProjectGroupData`, sorted by
     * project name. Files within a group are sorted by file path for stable ordering.
     */
    private buildProjectGroups(projectsByPath: Map<string, DeepnoteProject>): ProjectGroupData[] {
        const groupsById = new Map<string, ProjectGroupData>();

        for (const [filePath, project] of projectsByPath) {
            const projectId = project.project.id;
            let group = groupsById.get(projectId);

            if (!group) {
                group = {
                    projectId,
                    projectName: project.project.name || 'Untitled Project',
                    files: []
                };
                groupsById.set(projectId, group);
            }

            group.files.push({ filePath, project });
        }

        const groups = Array.from(groupsById.values());

        for (const group of groups) {
            group.files.sort((a, b) => a.filePath.localeCompare(b.filePath));
        }

        groups.sort((a, b) => a.projectName.toLowerCase().localeCompare(b.projectName.toLowerCase()));

        return groups;
    }

    /**
     * Children of a `ProjectGroup`: one `ProjectFile` per sibling file. A single-notebook file is a
     * leaf; a legacy multi-notebook file is collapsible into its notebooks.
     */
    private async getFilesForGroup(groupItem: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        const group = groupItem.data as ProjectGroupData;
        const fileItems: DeepnoteTreeItem[] = [];

        for (const { filePath, project } of group.files) {
            const isLeaf = getNonInitNotebooks(project).length === 1;
            const collapsibleState = isLeaf ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Collapsed;

            const context: DeepnoteTreeItemContext = {
                filePath,
                projectId: project.project.id
            };

            let fileItem = this.fileItemCache.get(filePath);

            if (fileItem) {
                fileItem.data = project;
                fileItem.collapsibleState = collapsibleState;
                fileItem.updateVisualFields();
            } else {
                fileItem = new DeepnoteTreeItem(DeepnoteTreeItemType.ProjectFile, context, project, collapsibleState);
                this.fileItemCache.set(filePath, fileItem);
            }

            fileItems.push(fileItem);
        }

        fileItems.sort(compareTreeItemsByLabel);

        return fileItems;
    }

    /**
     * Children of a legacy multi-notebook `ProjectFile`: one `Notebook` per non-init notebook.
     */
    private async getNotebooksForProjectFile(projectItem: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        const project = projectItem.data as DeepnoteProject;
        const notebooks = getNonInitNotebooks(project);

        // Sort notebooks alphabetically by name (case-insensitive)
        const sortedNotebooks = [...notebooks].sort((a, b) => {
            const nameA = a.name || '';
            const nameB = b.name || '';

            return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
        });

        return sortedNotebooks.map((notebook: DeepnoteNotebook) => {
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

    /**
     * Scan every workspace folder for `.deepnote` files (skipping snapshots) and populate
     * `cachedProjects`. Returns the file→project map used to build groups.
     */
    private async loadAllProjects(): Promise<Map<string, DeepnoteProject>> {
        for (const workspaceFolder of workspace.workspaceFolders || []) {
            const pattern = new RelativePattern(workspaceFolder, '**/*.deepnote');
            const files = await workspace.findFiles(pattern);
            const projectFiles = files.filter((file) => !file.path.endsWith(SNAPSHOT_FILE_SUFFIX));

            for (const file of projectFiles) {
                try {
                    await this.loadDeepnoteProject(file);
                } catch (error) {
                    this.logger?.error(`Failed to load Deepnote project from ${file.path}`, error);
                }
            }
        }

        return this.cachedProjects;
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

        // Handle case where file watcher creation fails (e.g., in test environment)
        if (!this.fileWatcher) {
            return;
        }

        this.fileWatcher.onDidChange((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }

            this.refreshProject(uri.path);
        });

        this.fileWatcher.onDidCreate((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }

            // New file created: evict by path (no-op if absent) and do a full-tree refresh.
            this.cachedProjects.delete(uri.path);
            this.fileItemCache.delete(uri.path);
            this._onDidChangeTreeData.fire(undefined);
        });

        this.fileWatcher.onDidDelete((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }

            // File deleted: evict by path and do a full-tree refresh.
            this.cachedProjects.delete(uri.path);
            this.fileItemCache.delete(uri.path);
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    private updateContextKey(): void {
        void commands.executeCommand('setContext', 'deepnote.explorerInitialScanComplete', this.isInitialScanComplete);
    }
}
