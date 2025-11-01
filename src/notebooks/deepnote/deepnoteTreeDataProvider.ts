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

import { DeepnoteTreeItem, DeepnoteTreeItemType, DeepnoteTreeItemContext } from './deepnoteTreeItem';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { readDeepnoteProjectFile } from './deepnoteProjectUtils';

/**
 * Tree data provider for the Deepnote explorer view.
 * Manages the tree structure displaying Deepnote project files and their notebooks.
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

    constructor() {
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
     * @param filePath The path to the project file to refresh
     */
    public async refreshProject(filePath: string): Promise<void> {
        // Get the cached tree item BEFORE clearing caches
        const cacheKey = `project:${filePath}`;
        const cachedTreeItem = this.treeItemCache.get(cacheKey);

        // Clear the project data cache to force reload
        this.cachedProjects.delete(filePath);

        if (cachedTreeItem) {
            // Reload the project data and update the cached tree item
            try {
                const fileUri = Uri.file(filePath);
                const project = await this.loadDeepnoteProject(fileUri);
                if (project) {
                    // Update the tree item's data
                    cachedTreeItem.data = project;
                }
            } catch (error) {
                console.error(`Failed to reload project ${filePath}:`, error);
            }

            // Fire change event with the existing cached tree item
            this._onDidChangeTreeData.fire(cachedTreeItem);
        } else {
            // If not found in cache, do a full refresh
            this._onDidChangeTreeData.fire();
        }
    }

    /**
     * Refresh notebooks for a specific project
     * @param projectId The project ID whose notebooks should be refreshed
     */
    public async refreshNotebook(projectId: string): Promise<void> {
        // Find the cached tree item by scanning the cache
        let cachedTreeItem: DeepnoteTreeItem | undefined;
        let filePath: string | undefined;

        for (const [key, item] of this.treeItemCache.entries()) {
            if (key.startsWith('project:') && item.context.projectId === projectId) {
                cachedTreeItem = item;
                filePath = item.context.filePath;
                break;
            }
        }

        if (cachedTreeItem && filePath) {
            // Clear the project data cache to force reload
            this.cachedProjects.delete(filePath);

            // Reload the project data and update the cached tree item
            try {
                const fileUri = Uri.file(filePath);
                const project = await this.loadDeepnoteProject(fileUri);
                if (project) {
                    // Update the tree item's data
                    cachedTreeItem.data = project;
                }
            } catch (error) {
                console.error(`Failed to reload project ${filePath}:`, error);
            }

            // Fire change event with the existing cached tree item to refresh its children
            this._onDidChangeTreeData.fire(cachedTreeItem);
        } else {
            // If not found in cache, do a full refresh
            this._onDidChangeTreeData.fire();
        }
    }

    public getTreeItem(element: DeepnoteTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        // If element is provided, we can return children regardless of workspace
        if (element) {
            if (element.type === DeepnoteTreeItemType.ProjectFile) {
                return this.getNotebooksForProject(element);
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

        return this.getDeepnoteProjectFiles();
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
            await this.getDeepnoteProjectFiles();
        } finally {
            this.isInitialScanComplete = true;
            this.initialScanPromise = undefined;
            this.updateContextKey();
            this._onDidChangeTreeData.fire();
        }
    }

    private async getDeepnoteProjectFiles(): Promise<DeepnoteTreeItem[]> {
        const deepnoteFiles: DeepnoteTreeItem[] = [];

        for (const workspaceFolder of workspace.workspaceFolders || []) {
            const pattern = new RelativePattern(workspaceFolder, '**/*.deepnote');
            const files = await workspace.findFiles(pattern);

            for (const file of files) {
                try {
                    const project = await this.loadDeepnoteProject(file);
                    if (!project) {
                        continue;
                    }

                    const context: DeepnoteTreeItemContext = {
                        filePath: file.path,
                        projectId: project.project.id
                    };

                    // Check if we have a cached tree item for this project
                    const cacheKey = `project:${file.path}`;
                    let treeItem = this.treeItemCache.get(cacheKey);

                    if (!treeItem) {
                        // Create new tree item only if not cached
                        const hasNotebooks = project.project.notebooks && project.project.notebooks.length > 0;
                        const collapsibleState = hasNotebooks
                            ? TreeItemCollapsibleState.Collapsed
                            : TreeItemCollapsibleState.None;

                        treeItem = new DeepnoteTreeItem(
                            DeepnoteTreeItemType.ProjectFile,
                            context,
                            project,
                            collapsibleState
                        );

                        this.treeItemCache.set(cacheKey, treeItem);
                    } else {
                        // Update the cached tree item's data
                        treeItem.data = project;
                    }

                    deepnoteFiles.push(treeItem);
                } catch (error) {
                    console.error(`Failed to load Deepnote project from ${file.path}:`, error);
                }
            }
        }

        // Sort projects alphabetically by name (case-insensitive)
        deepnoteFiles.sort((a, b) => {
            const labelA = typeof a.label === 'string' ? a.label : '';
            const labelB = typeof b.label === 'string' ? b.label : '';
            return labelA.toLowerCase().localeCompare(labelB.toLowerCase());
        });

        return deepnoteFiles;
    }

    private async getNotebooksForProject(projectItem: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        const project = projectItem.data as DeepnoteProject;
        const notebooks = project.project.notebooks || [];

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
            console.error(`Failed to parse Deepnote file ${filePath}:`, error);
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
            // Use granular refresh for file changes
            void this.refreshProject(uri.path);
        });

        this.fileWatcher.onDidCreate(() => {
            // New file created, do full refresh
            this._onDidChangeTreeData.fire();
        });

        this.fileWatcher.onDidDelete((uri) => {
            // File deleted, clear cache and do full refresh
            this.cachedProjects.delete(uri.path);
            this._onDidChangeTreeData.fire();
        });
    }

    /**
     * Find a tree item by project ID and optional notebook ID
     */
    public async findTreeItem(projectId: string, notebookId?: string): Promise<DeepnoteTreeItem | undefined> {
        const projectFiles = await this.getDeepnoteProjectFiles();

        for (const projectItem of projectFiles) {
            if (projectItem.context.projectId === projectId) {
                if (!notebookId) {
                    return projectItem;
                }

                const notebooks = await this.getNotebooksForProject(projectItem);
                for (const notebookItem of notebooks) {
                    if (notebookItem.context.notebookId === notebookId) {
                        return notebookItem;
                    }
                }
            }
        }

        return undefined;
    }

    private updateContextKey(): void {
        void commands.executeCommand('setContext', 'deepnote.explorerInitialScanComplete', this.isInitialScanComplete);
    }
}
