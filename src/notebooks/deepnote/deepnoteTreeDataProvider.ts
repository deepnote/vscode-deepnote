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
    getNonInitNotebooks,
    isSingleNotebookFile,
    resolveLeafNotebook
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
 * Explorer tree: root → `ProjectGroup` (per `project.id`) → `ProjectFile` → `Notebook` (legacy only).
 * Groups re-derive from the URI-keyed `cachedProjects` per read, so refreshes fire a full-tree change.
 */
export class DeepnoteTreeDataProvider implements TreeDataProvider<DeepnoteTreeItem> {
    private _onDidChangeTreeData: EventEmitter<DeepnoteTreeItem | undefined | null | void> = new EventEmitter<
        DeepnoteTreeItem | undefined | null | void
    >();
    readonly onDidChangeTreeData: Event<DeepnoteTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private fileWatcher: FileSystemWatcher | undefined;
    private cachedProjects: Map<string /* uri.toString() */, DeepnoteProject> = new Map();
    private groupItemCache: Map<string /* projectId */, DeepnoteTreeItem> = new Map();
    private fileItemCache: Map<string /* uri.toString() */, DeepnoteTreeItem> = new Map();
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
     * Refresh a single project file. Fires a full-tree change (not a scoped one) because a file
     * change can move it between groups or alter a group's collapse state/label.
     */
    public refreshProject(cacheKey: string): void {
        this.cachedProjects.delete(cacheKey);
        this.fileItemCache.delete(cacheKey);
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Refresh every sibling file of a project. Evicts ALL matching `cachedProjects` entries (never
     * breaking on the first match) so the whole group stays consistent.
     */
    public refreshNotebook(projectId: string): void {
        for (const [cacheKey, project] of this.cachedProjects) {
            if (project.project.id === projectId) {
                this.cachedProjects.delete(cacheKey);
                this.fileItemCache.delete(cacheKey);
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
            if (element.extra.type === DeepnoteTreeItemType.ProjectGroup) {
                return this.getFilesForGroup(element);
            }

            if (element.extra.type === DeepnoteTreeItemType.ProjectFile) {
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

                if (
                    fileItem.collapsibleState === TreeItemCollapsibleState.None &&
                    fileItem.extra.type === DeepnoteTreeItemType.ProjectFile
                ) {
                    const leafNotebook = resolveLeafNotebook(fileItem.extra.data);

                    if (leafNotebook?.id === notebookId) {
                        return fileItem;
                    }

                    continue;
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

    /**
     * Return an element's parent from the item caches; `TreeView.reveal` requires `getParent`.
     */
    public getParent(element: DeepnoteTreeItem): DeepnoteTreeItem | undefined {
        if (element.extra.type === DeepnoteTreeItemType.Notebook) {
            return this.fileItemCache.get(Uri.file(element.context.filePath).toString());
        }

        if (element.extra.type === DeepnoteTreeItemType.ProjectFile) {
            return this.groupItemCache.get(element.context.projectId);
        }

        return undefined;
    }

    private createLoadingTreeItem(): DeepnoteTreeItem {
        const loadingItem = new DeepnoteTreeItem(
            { filePath: '', projectId: '' },
            { type: DeepnoteTreeItemType.Loading, data: null },
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

    /** Build the root-level `ProjectGroup` nodes; single-file groups are expanded. */
    private async getProjectGroups(): Promise<DeepnoteTreeItem[]> {
        const projectsByPath = await this.loadAllProjects();
        const groups = this.buildProjectGroups(projectsByPath);

        const groupItems: DeepnoteTreeItem[] = [];

        for (const group of groups) {
            const collapsibleState =
                group.files.length > 1 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.Expanded;

            let groupItem = this.groupItemCache.get(group.projectId);

            if (groupItem?.extra.type === DeepnoteTreeItemType.ProjectGroup) {
                groupItem.extra.data = group;
                groupItem.collapsibleState = collapsibleState;
                groupItem.updateVisualFields();
            } else {
                groupItem = new DeepnoteTreeItem(
                    { filePath: group.files[0]?.filePath ?? '', projectId: group.projectId },
                    { type: DeepnoteTreeItemType.ProjectGroup, data: group },
                    collapsibleState
                );
                this.groupItemCache.set(group.projectId, groupItem);
            }

            groupItems.push(groupItem);
        }

        groupItems.sort(compareTreeItemsByLabel);

        return groupItems;
    }

    /** Group file→project entries by `project.id`; files sorted by path for stable ordering. */
    private buildProjectGroups(projectsByPath: Map<string, DeepnoteProject>): ProjectGroupData[] {
        const groupsById = new Map<string, ProjectGroupData>();

        for (const [cacheKey, project] of projectsByPath) {
            const filePath = Uri.parse(cacheKey).path;
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

            group.files.push({ filePath, cacheKey, project });
        }

        const groups = Array.from(groupsById.values());

        for (const group of groups) {
            group.files.sort((a, b) => a.filePath.localeCompare(b.filePath));
        }

        groups.sort((a, b) => a.projectName.toLowerCase().localeCompare(b.projectName.toLowerCase()));

        return groups;
    }

    /** Children of a `ProjectGroup`: one `ProjectFile` per sibling file. */
    private async getFilesForGroup(groupItem: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        if (groupItem.extra.type !== DeepnoteTreeItemType.ProjectGroup) {
            return [];
        }

        const group = groupItem.extra.data;
        const fileItems: DeepnoteTreeItem[] = [];

        for (const { filePath, cacheKey, project } of group.files) {
            const isLeaf = isSingleNotebookFile(project);
            const collapsibleState = isLeaf ? TreeItemCollapsibleState.None : TreeItemCollapsibleState.Collapsed;

            const context: DeepnoteTreeItemContext = {
                filePath,
                projectId: project.project.id
            };

            let fileItem = this.fileItemCache.get(cacheKey);

            if (fileItem?.extra.type === DeepnoteTreeItemType.ProjectFile) {
                fileItem.extra.data = project;
                fileItem.collapsibleState = collapsibleState;
                fileItem.updateVisualFields();
            } else {
                fileItem = new DeepnoteTreeItem(
                    context,
                    { type: DeepnoteTreeItemType.ProjectFile, data: project },
                    collapsibleState
                );
                this.fileItemCache.set(cacheKey, fileItem);
            }

            fileItems.push(fileItem);
        }

        fileItems.sort(compareTreeItemsByLabel);

        return fileItems;
    }

    /** Children of a legacy multi-notebook `ProjectFile`: one `Notebook` per non-init notebook. */
    private async getNotebooksForProjectFile(projectItem: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        if (projectItem.extra.type !== DeepnoteTreeItemType.ProjectFile) {
            return [];
        }

        const project = projectItem.extra.data;
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
                context,
                { type: DeepnoteTreeItemType.Notebook, data: notebook },
                TreeItemCollapsibleState.None
            );
        });
    }

    /** Scan workspace folders for `.deepnote` files (skipping snapshots) into `cachedProjects`. */
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
        const cacheKey = fileUri.toString();

        const cached = this.cachedProjects.get(cacheKey);

        if (cached) {
            return cached;
        }

        try {
            const project = await readDeepnoteProjectFile(fileUri);

            if (project && project.project && project.project.id) {
                this.cachedProjects.set(cacheKey, project);

                return project;
            }
        } catch (error) {
            this.logger?.error(`Failed to parse Deepnote file ${fileUri.path}`, error);
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

            this.refreshProject(uri.toString());
        });

        this.fileWatcher.onDidCreate((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }

            this.cachedProjects.delete(uri.toString());
            this.fileItemCache.delete(uri.toString());
            this._onDidChangeTreeData.fire(undefined);
        });

        this.fileWatcher.onDidDelete((uri) => {
            if (isSnapshotFile(uri)) {
                return;
            }

            this.cachedProjects.delete(uri.toString());
            this.fileItemCache.delete(uri.toString());
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    private updateContextKey(): void {
        void commands.executeCommand('setContext', 'deepnote.explorerInitialScanComplete', this.isInitialScanComplete);
    }
}
