import { TreeItem, TreeItemCollapsibleState, Uri, ThemeIcon } from 'vscode';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

/**
 * Represents different types of items in the Deepnote tree view
 */
export enum DeepnoteTreeItemType {
    ProjectFile = 'projectFile',
    Notebook = 'notebook',
    Loading = 'loading'
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
        public data: DeepnoteProject | DeepnoteNotebook | null,
        collapsibleState: TreeItemCollapsibleState
    ) {
        super('', collapsibleState);

        this.contextValue = this.type;

        // Inline method calls to avoid ES module TreeItem extension issues
        if (this.type !== DeepnoteTreeItemType.Loading) {
            // getTooltip() inline
            if (this.type === DeepnoteTreeItemType.ProjectFile) {
                const project = this.data as DeepnoteProject;
                this.tooltip = `Deepnote Project: ${project.project.name}\nFile: ${this.context.filePath}`;
            } else {
                const notebook = this.data as DeepnoteNotebook;
                this.tooltip = `Notebook: ${notebook.name}\nExecution Mode: ${notebook.executionMode}`;
            }

            // getIcon() inline
            if (this.type === DeepnoteTreeItemType.ProjectFile) {
                this.iconPath = new ThemeIcon('notebook');
            } else {
                this.iconPath = new ThemeIcon('file-code');
            }

            // getLabel() inline
            if (this.type === DeepnoteTreeItemType.ProjectFile) {
                const project = this.data as DeepnoteProject;
                this.label = project.project.name || 'Untitled Project';
            } else {
                const notebook = this.data as DeepnoteNotebook;
                this.label = notebook.name || 'Untitled Notebook';
            }

            // getDescription() inline
            if (this.type === DeepnoteTreeItemType.ProjectFile) {
                const project = this.data as DeepnoteProject;
                const notebookCount = project.project.notebooks?.length || 0;
                this.description = `${notebookCount} notebook${notebookCount !== 1 ? 's' : ''}`;
            } else {
                const notebook = this.data as DeepnoteNotebook;
                const blockCount = notebook.blocks?.length || 0;
                this.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
            }
        }

        if (this.type === DeepnoteTreeItemType.Notebook) {
            // getNotebookUri() inline
            if (this.context.notebookId) {
                this.resourceUri = Uri.parse(`deepnote-notebook://${this.context.filePath}#${this.context.notebookId}`);
            }
            this.command = {
                command: 'deepnote.openNotebook',
                title: 'Open Notebook',
                arguments: [this.context]
            };
        }
    }

    /**
     * Updates the tree item's visual fields (label, description, tooltip) based on current data.
     * Call this after updating the data property to ensure the tree view reflects changes.
     */
    public updateVisualFields(): void {
        // Inline the same logic as in constructor
        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            const project = this.data as DeepnoteProject;
            this.label = project.project.name || 'Untitled Project';
            this.tooltip = `Deepnote Project: ${project.project.name}\nFile: ${this.context.filePath}`;
            const notebookCount = project.project.notebooks?.length || 0;
            this.description = `${notebookCount} notebook${notebookCount !== 1 ? 's' : ''}`;
        } else {
            const notebook = this.data as DeepnoteNotebook;
            this.label = notebook.name || 'Untitled Notebook';
            this.tooltip = `Notebook: ${notebook.name}\nExecution Mode: ${notebook.executionMode}`;
            const blockCount = notebook.blocks?.length || 0;
            this.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
        }
    }
}
