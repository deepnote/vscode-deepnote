import { TreeItem, TreeItemCollapsibleState, ThemeIcon } from 'vscode';
import type { DeepnoteProject, DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';

/**
 * Tree item types: `ProjectGroup` (one per `project.id`) → `ProjectFile` (one `.deepnote` file,
 * a leaf when it has a single non-init notebook) → `Notebook` (legacy multi-notebook child).
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
    // `filePath` is the native path (for `Uri.file`); `cacheKey` is the opaque `Uri.toString()` cache key.
    readonly files: Array<{ filePath: string; cacheKey: string; project: DeepnoteProject }>;
}

/**
 * Notebooks of a project excluding the init notebook (`project.initNotebookId`).
 */
export function getNonInitNotebooks(project: DeepnoteProject): DeepnoteNotebook[] {
    const notebooks = project.project.notebooks ?? [];
    const initNotebookId = project.project.initNotebookId;

    return notebooks.filter((notebook) => notebook.id !== initNotebookId);
}

/**
 * True when a file renders as a single-notebook leaf: one non-init notebook, or an init-only file
 * whose sole notebook is the init notebook.
 */
export function isSingleNotebookFile(project: DeepnoteProject): boolean {
    const nonInit = getNonInitNotebooks(project);

    if (nonInit.length === 1) {
        return true;
    }

    return nonInit.length === 0 && (project.project.notebooks?.length ?? 0) === 1;
}

/**
 * The single notebook to render for a leaf file: first non-init notebook, falling back to the
 * first notebook when the only notebook IS the init notebook.
 */
export function resolveLeafNotebook(project: DeepnoteProject): DeepnoteNotebook | undefined {
    const nonInit = getNonInitNotebooks(project);

    if (nonInit.length > 0) {
        return nonInit[0];
    }

    return project.project.notebooks?.[0];
}

/**
 * Sets the item's visual fields from its type/data. A free function, not a method: calling a
 * subclass method from a `TreeItem` constructor is unsafe in transpiled ES-module output.
 */
export function applyVisualFields(item: DeepnoteTreeItem): void {
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

        if (isSingleNotebookFile(project)) {
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
     * Re-applies the visual fields; call after mutating `data` to reflect changes in the tree.
     */
    public updateVisualFields(): void {
        applyVisualFields(this);
    }
}
