import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

/**
 * Represents different types of items in the Deepnote tree view.
 *
 * - `ProjectGroup` — a project (one per distinct `project.id`) grouping its sibling files.
 * - `ProjectFile` — a single `.deepnote` file. A file with exactly one non-init notebook is
 *   rendered as a leaf (`notebookFile`); a legacy multi-notebook file is collapsible into
 *   `Notebook` children (`projectFile`).
 * - `Notebook` — a legacy in-file notebook child of a multi-notebook `ProjectFile`.
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
 * Data backing a `ProjectGroup` node: all sibling `.deepnote` files that share one `project.id`.
 */
export interface ProjectGroupData {
    readonly projectId: string;
    readonly projectName: string;
    readonly files: Array<{ filePath: string; project: DeepnoteProject }>;
}

/**
 * Returns the notebooks of a project file that are NOT the init notebook.
 * The init notebook (referenced by `project.initNotebookId`) is excluded from every count/label.
 */
export function getNonInitNotebooks(project: DeepnoteProject): DeepnoteNotebook[] {
    const notebooks = project.project.notebooks ?? [];
    const initNotebookId = project.project.initNotebookId;

    return notebooks.filter((notebook) => notebook.id !== initNotebookId);
}

/**
 * Resolves the single notebook to render for a single-notebook file: the first non-init notebook,
 * falling back to the first notebook when the only notebook IS the init notebook.
 */
function resolveLeafNotebook(project: DeepnoteProject): DeepnoteNotebook | undefined {
    const nonInit = getNonInitNotebooks(project);

    if (nonInit.length > 0) {
        return nonInit[0];
    }

    return project.project.notebooks?.[0];
}

/**
 * Mutates the tree item's visual fields (label, description, tooltip, icon, command, context value)
 * based on its current type and data.
 *
 * Implemented as a free function (rather than an instance method) so it can be called from the
 * constructor: in the transpiled ES-module output, calling a subclass instance method from a
 * `TreeItem` subclass constructor is not safe (the prototype is not yet fully wired), which is why
 * the original implementation inlined all rendering in the constructor body.
 */
function applyVisualFields(item: DeepnoteTreeItem): void {
    if (item.type === DeepnoteTreeItemType.Loading) {
        item.contextValue = 'loading';
        item.label = 'Loading…';
        item.tooltip = 'Loading…';
        item.description = '';
        item.iconPath = new ThemeIcon('loading~spin');

        return;
    }

    if (item.type === DeepnoteTreeItemType.ProjectGroup) {
        const group = item.data as ProjectGroupData;
        const fileCount = group.files?.length ?? 0;

        item.contextValue = 'projectGroup';
        item.label = group.projectName || 'Untitled Project';
        item.tooltip = `Deepnote Project: ${group.projectName}`;
        item.description = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
        item.iconPath = new ThemeIcon('folder');
        item.command = undefined;

        return;
    }

    if (item.type === DeepnoteTreeItemType.ProjectFile) {
        const project = item.data as DeepnoteProject;
        const nonInitNotebooks = getNonInitNotebooks(project);

        // A file with exactly one non-init notebook is a leaf labelled with that notebook's name.
        if (nonInitNotebooks.length === 1) {
            const notebook = resolveLeafNotebook(project);
            const blockCount = notebook?.blocks?.length ?? 0;

            item.contextValue = 'notebookFile';
            item.label = notebook?.name || 'Untitled Notebook';
            item.tooltip = `Notebook: ${notebook?.name ?? ''}\nFile: ${item.context.filePath}`;
            item.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
            item.iconPath = new ThemeIcon('notebook');
            item.command = {
                command: 'deepnote.openNotebook',
                title: 'Open Notebook',
                arguments: [
                    {
                        filePath: item.context.filePath,
                        projectId: item.context.projectId,
                        notebookId: notebook?.id
                    } satisfies DeepnoteTreeItemContext
                ]
            };

            return;
        }

        // Legacy multi-notebook (or empty) file: collapsible into Notebook children.
        item.contextValue = 'projectFile';
        item.label = project.project.name || 'Untitled Project';
        item.tooltip = `Deepnote Project: ${project.project.name}\nFile: ${item.context.filePath}`;
        item.description = `${nonInitNotebooks.length} notebook${nonInitNotebooks.length !== 1 ? 's' : ''}`;
        item.iconPath = new ThemeIcon('notebook');
        item.command = undefined;

        return;
    }

    const notebook = item.data as DeepnoteNotebook;
    const blockCount = notebook.blocks?.length ?? 0;

    item.contextValue = 'notebook';
    item.label = notebook.name || 'Untitled Notebook';
    item.tooltip = `Notebook: ${notebook.name}\nExecution Mode: ${notebook.executionMode}`;
    item.description = `${blockCount} cell${blockCount !== 1 ? 's' : ''}`;
    item.iconPath = new ThemeIcon('file-code');
    item.command = {
        command: 'deepnote.openNotebook',
        title: 'Open Notebook',
        arguments: [item.context]
    };
}

/**
 * Tree item representing a Deepnote project group, project file, or in-file notebook in the
 * explorer view.
 */
export class DeepnoteTreeItem extends TreeItem {
    constructor(
        public readonly type: DeepnoteTreeItemType,
        public readonly context: DeepnoteTreeItemContext,
        public data: DeepnoteProject | DeepnoteNotebook | ProjectGroupData | null,
        collapsibleState: TreeItemCollapsibleState
    ) {
        super('', collapsibleState);

        applyVisualFields(this);
    }

    /**
     * Updates the tree item's visual fields (label, description, tooltip, icon, command, context
     * value) based on current data. Call this after updating the data property to ensure the tree
     * view reflects changes.
     */
    public updateVisualFields(): void {
        applyVisualFields(this);
    }
}
