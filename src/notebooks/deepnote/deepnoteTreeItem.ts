import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from 'vscode';

import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { basename } from '../../platform/vscode-path/path';

/**
 * Represents different types of items in the Deepnote tree view
 */
export enum DeepnoteTreeItemType {
    ProjectGroup = 'projectGroup',
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
 * Data associated with a ProjectGroup tree item
 */
export interface ProjectGroupData {
    readonly projectId: string;
    readonly projectName: string;
    readonly files: Array<{ filePath: string; project: DeepnoteProject }>;
}

/**
 * contextValue assigned to a `.deepnote` file row that represents a single notebook
 * (i.e., a `ProjectFile` that carries notebook-level actions in the tree menu).
 */
export const NOTEBOOK_FILE_CONTEXT_VALUE = 'notebookFile';

/**
 * Tree item representing a Deepnote project group, file, or notebook in the explorer view
 */
export class DeepnoteTreeItem extends TreeItem {
    constructor(
        public readonly type: DeepnoteTreeItemType,
        public readonly context: DeepnoteTreeItemContext,
        public data: DeepnoteProject | DeepnoteNotebook | ProjectGroupData | null,
        collapsibleState: TreeItemCollapsibleState
    ) {
        super('', collapsibleState);

        this.contextValue = this.type;

        if (this.type === DeepnoteTreeItemType.Loading) {
            this.label = 'Loading…';
            this.tooltip = 'Loading…';
            this.description = '';
            this.iconPath = new ThemeIcon('loading~spin');
        } else if (this.type === DeepnoteTreeItemType.ProjectGroup) {
            const groupData = this.data as ProjectGroupData;
            this.label = groupData.projectName || 'Untitled Project';
            this.tooltip = `Deepnote Project: ${groupData.projectName}\n${groupData.files.length} file(s)`;
            this.description = `${groupData.files.length} file${groupData.files.length !== 1 ? 's' : ''}`;
            this.iconPath = new ThemeIcon('notebook');
        } else {
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
                this.iconPath = new ThemeIcon('file-code');
            } else {
                this.iconPath = new ThemeIcon('file-code');
            }

            // getLabel() inline
            if (this.type === DeepnoteTreeItemType.ProjectFile) {
                const project = this.data as DeepnoteProject;
                const singleNonInitNotebook = getSingleNonInitNotebook(project);

                if (singleNonInitNotebook) {
                    this.label = singleNonInitNotebook.name || project.project.name || 'Untitled Notebook';
                    this.contextValue = NOTEBOOK_FILE_CONTEXT_VALUE;
                } else {
                    const fileName = basename(this.context.filePath);
                    this.label = fileName || project.project.name || 'Untitled Project';
                }
            } else {
                const notebook = this.data as DeepnoteNotebook;
                this.label = notebook.name || 'Untitled Notebook';
            }

            // getDescription() inline
            if (this.type === DeepnoteTreeItemType.ProjectFile) {
                const project = this.data as DeepnoteProject;
                const initNotebookId = project.project.initNotebookId;
                const nonInitNotebooks = project.project.notebooks?.filter((nb) => nb.id !== initNotebookId) ?? [];
                const blockCount = nonInitNotebooks.reduce((sum, nb) => sum + (nb.blocks?.length ?? 0), 0);
                this.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
            } else {
                const notebook = this.data as DeepnoteNotebook;
                const blockCount = notebook.blocks?.length || 0;
                this.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
            }
        }

        // ProjectFile items open the file directly (no query param)
        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            this.command = {
                command: 'deepnote.openNotebook',
                title: 'Open Notebook',
                arguments: [this.context]
            };
        }

        // Notebook items also open the file directly (no query param)
        if (this.type === DeepnoteTreeItemType.Notebook) {
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
        if (this.type === DeepnoteTreeItemType.Loading) {
            this.label = 'Loading…';
            this.tooltip = 'Loading…';
            this.description = '';
            this.iconPath = new ThemeIcon('loading~spin');
            return;
        }

        if (this.type === DeepnoteTreeItemType.ProjectGroup) {
            const groupData = this.data as ProjectGroupData;
            this.label = groupData.projectName || 'Untitled Project';
            this.tooltip = `Deepnote Project: ${groupData.projectName}\n${groupData.files.length} file(s)`;
            this.description = `${groupData.files.length} file${groupData.files.length !== 1 ? 's' : ''}`;
            return;
        }

        if (this.type === DeepnoteTreeItemType.ProjectFile) {
            const project = this.data as DeepnoteProject;
            const singleNonInitNotebook = getSingleNonInitNotebook(project);

            if (singleNonInitNotebook) {
                this.label = singleNonInitNotebook.name || project.project.name || 'Untitled Notebook';
                this.contextValue = NOTEBOOK_FILE_CONTEXT_VALUE;
            } else {
                const fileName = basename(this.context.filePath);
                this.label = fileName || project.project.name || 'Untitled Project';
                this.contextValue = this.type;
            }
            this.tooltip = `Deepnote Project: ${project.project.name}\nFile: ${this.context.filePath}`;

            const initNotebookId = project.project.initNotebookId;
            const nonInitNotebooks = project.project.notebooks?.filter((nb) => nb.id !== initNotebookId) ?? [];
            const blockCount = nonInitNotebooks.reduce((sum, nb) => sum + (nb.blocks?.length ?? 0), 0);
            this.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
        } else {
            const notebook = this.data as DeepnoteNotebook;

            this.label = notebook.name || 'Untitled Notebook';
            this.tooltip = `Notebook: ${notebook.name}\nExecution Mode: ${notebook.executionMode}`;

            const blockCount = notebook.blocks?.length || 0;

            this.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
        }
    }
}

/**
 * Returns the sole non-init notebook on a project, or undefined if the project has zero
 * or multiple non-init notebooks. Used to decide whether a `ProjectFile` row should act as
 * a notebook (label + notebook actions) versus a legacy multi-notebook container.
 */
export function getSingleNonInitNotebook(project: DeepnoteProject): DeepnoteNotebook | undefined {
    const initNotebookId = project.project.initNotebookId;
    const nonInitNotebooks = project.project.notebooks?.filter((nb) => nb.id !== initNotebookId) ?? [];

    return nonInitNotebooks.length === 1 ? nonInitNotebooks[0] : undefined;
}
