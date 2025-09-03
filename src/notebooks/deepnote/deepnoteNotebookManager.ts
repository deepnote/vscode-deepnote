import type { DeepnoteProject } from './deepnoteTypes';

export class DeepnoteNotebookManager {
    private currentNotebookId = new Map<string, string>();
    private originalProjects = new Map<string, DeepnoteProject>();
    private selectedNotebookByUri = new Map<string, string>();
    private skipPromptForUri = new Set<string>();

    getCurrentNotebookId(projectId: string): string | undefined {
        return this.currentNotebookId.get(projectId);
    }

    getOriginalProject(projectId: string): DeepnoteProject | undefined {
        return this.originalProjects.get(projectId);
    }

    getSelectedNotebookForUri(uri: string): string | undefined {
        return this.selectedNotebookByUri.get(uri);
    }

    /**
     * Associates a notebook ID with a file URI to remember user's notebook selection.
     * When a Deepnote file contains multiple notebooks, this mapping persists the user's
     * choice so we can automatically open the same notebook on subsequent file opens.
     * Also marks the URI to skip the selection prompt on the next immediate open.
     *
     * @param uri - The file URI (or project ID) that identifies the Deepnote file
     * @param notebookId - The ID of the selected notebook within the file
     */
    setSelectedNotebookForUri(uri: string, notebookId: string): void {
        this.selectedNotebookByUri.set(uri, notebookId);
        this.skipPromptForUri.add(uri);
    }

    shouldSkipPrompt(uri: string): boolean {
        if (this.skipPromptForUri.has(uri)) {
            this.skipPromptForUri.delete(uri);

            return true;
        }

        return false;
    }

    storeOriginalProject(projectId: string, project: DeepnoteProject, notebookId: string): void {
        this.originalProjects.set(projectId, project);
        this.currentNotebookId.set(projectId, notebookId);
    }

    updateCurrentNotebookId(projectId: string, notebookId: string): void {
        this.currentNotebookId.set(projectId, notebookId);
    }
}
