import {
    TreeDataProvider,
    TreeItem,
    TreeItemCollapsibleState,
    Event,
    EventEmitter,
    workspace,
    RelativePattern,
    Uri,
    FileSystemWatcher
} from 'vscode';
import * as yaml from 'js-yaml';

import { DeepnoteTreeItem, DeepnoteTreeItemType, DeepnoteTreeItemContext } from './deepnoteTreeItem';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

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

    constructor() {
        this.setupFileWatcher();
    }

    public dispose(): void {
        this.fileWatcher?.dispose();
        this._onDidChangeTreeData.dispose();
    }

    public refresh(): void {
        this.cachedProjects.clear();
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: DeepnoteTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
        if (!workspace.workspaceFolders || workspace.workspaceFolders.length === 0) {
            return [];
        }

        if (!element) {
            return this.getDeepnoteProjectFiles();
        }

        if (element.type === DeepnoteTreeItemType.ProjectFile) {
            return this.getNotebooksForProject(element);
        }

        return [];
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

                    const hasNotebooks = project.project.notebooks && project.project.notebooks.length > 0;
                    const collapsibleState = hasNotebooks
                        ? TreeItemCollapsibleState.Collapsed
                        : TreeItemCollapsibleState.None;

                    const treeItem = new DeepnoteTreeItem(
                        DeepnoteTreeItemType.ProjectFile,
                        context,
                        project,
                        collapsibleState
                    );

                    deepnoteFiles.push(treeItem);
                } catch (error) {
                    console.error(`Failed to load Deepnote project from ${file.path}:`, error);
                }
            }
        }

        return deepnoteFiles;
    }

    private async getNotebooksForProject(projectItem: DeepnoteTreeItem): Promise<DeepnoteTreeItem[]> {
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
            const content = await workspace.fs.readFile(fileUri);
            const contentString = Buffer.from(content).toString('utf8');
            const project = yaml.load(contentString) as DeepnoteProject;

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
            this.cachedProjects.delete(uri.path);
            this._onDidChangeTreeData.fire();
        });

        this.fileWatcher.onDidCreate(() => {
            this._onDidChangeTreeData.fire();
        });

        this.fileWatcher.onDidDelete((uri) => {
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
}
