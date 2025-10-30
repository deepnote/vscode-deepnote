import { TreeItem, TreeItemCollapsibleState, Uri, ThemeIcon } from 'vscode';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

/**
 * Represents different types of items in the Deepnote tree view
 */
export enum DeepnoteTreeItemType {
    ProjectFile = 'projectFile',
    Notebook = 'notebook'
}

/**
 * Context data for Deepnote tree items
 */
export interface DeepnoteTreeItemContext {
    readonly filePath: string;
    readonly projectId: string;
    readonly notebookId?: string;
}

/**
 * Tree item representing a Deepnote project file or notebook in the explorer view
 */
export class DeepnoteTreeItem extends TreeItem {
    constructor(
        public readonly type: DeepnoteTreeItemType,
        public readonly context: DeepnoteTreeItemContext,
        public readonly data: DeepnoteProject | DeepnoteNotebook,
        collapsibleState: TreeItemCollapsibleState
    ) {
        super('', collapsibleState);

        this.contextValue = this.type;
        this.tooltip = this.getTooltip();
        this.iconPath = this.getIcon();
        this.label = this.getLabel();
        this.description = this.getDescription();

        if (this.type === DeepnoteTreeItemType.Notebook) {
            this.resourceUri = this.getNotebookUri();
            this.command = {
                command: 'deepnote.openNotebook',
                title: 'Open Notebook',
                arguments: [this.context]
            };
        }
    }

    private getLabel(): string {
        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            const project = this.data as DeepnoteProject;

            return project.project.name || 'Untitled Project';
        }

        const notebook = this.data as DeepnoteNotebook;

        return notebook.name || 'Untitled Notebook';
    }

    private getDescription(): string | undefined {
        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            const project = this.data as DeepnoteProject;
            const notebookCount = project.project.notebooks?.length || 0;

            return `${notebookCount} notebook${notebookCount !== 1 ? 's' : ''}`;
        }

        const notebook = this.data as DeepnoteNotebook;
        const blockCount = notebook.blocks?.length || 0;

        return `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
    }

    private getTooltip(): string {
        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            const project = this.data as DeepnoteProject;

            return `Deepnote Project: ${project.project.name}\nFile: ${this.context.filePath}`;
        }

        const notebook = this.data as DeepnoteNotebook;

        return `Notebook: ${notebook.name}\nExecution Mode: ${notebook.executionMode}`;
    }

    private getIcon(): ThemeIcon {
        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            return new ThemeIcon('notebook');
        }

        return new ThemeIcon('file-code');
    }

    private getNotebookUri(): Uri | undefined {
        if (this.type === DeepnoteTreeItemType.Notebook && this.context.notebookId) {
            return Uri.parse(`deepnote-notebook://${this.context.filePath}#${this.context.notebookId}`);
        }

        return undefined;
    }
}
