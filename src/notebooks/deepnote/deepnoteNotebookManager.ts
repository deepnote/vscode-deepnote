import type { DeepnoteProject } from './deepnoteTypes';

/**
 * Centralized manager for tracking Deepnote notebook selections and project state.
 * Manages per-project and per-URI state including current selections and user preferences.
 */
export class DeepnoteNotebookManager {
    private currentNotebookId = new Map<string, string>();
    private originalProjects = new Map<string, DeepnoteProject>();
    private selectedNotebookByUri = new Map<string, string>();
    private skipPromptForUri = new Set<string>();

    /**
     * Gets the currently selected notebook ID for a project.
     * @param projectId Project identifier
     * @returns Current notebook ID or undefined if not set
     */
    getCurrentNotebookId(projectId: string): string | undefined {
        return this.currentNotebookId.get(projectId);
    }

    /**
     * Retrieves the original project data for a given project ID.
     * @param projectId Project identifier
     * @returns Original project data or undefined if not found
     */
    getOriginalProject(projectId: string): DeepnoteProject | undefined {
        return this.originalProjects.get(projectId);
    }

    /**
     * Gets the selected notebook ID for a specific file URI.
     * @param uri File URI string
     * @returns Selected notebook ID or undefined if not set
     */
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

    /**
     * Checks if prompts should be skipped for a given URI and consumes the skip flag.
     * This is used to avoid showing selection prompts immediately after a user makes a choice.
     * @param uri File URI string
     * @returns True if prompts should be skipped (and resets the flag)
     */
    shouldSkipPrompt(uri: string): boolean {
        if (this.skipPromptForUri.has(uri)) {
            this.skipPromptForUri.delete(uri);

            return true;
        }

        return false;
    }

    /**
     * Stores the original project data and sets the initial current notebook.
     * This is used during deserialization to cache project data and track the active notebook.
     * @param projectId Project identifier
     * @param project Original project data to store
     * @param notebookId Initial notebook ID to set as current
     */
    storeOriginalProject(projectId: string, project: DeepnoteProject, notebookId: string): void {
        this.originalProjects.set(projectId, project);
        this.currentNotebookId.set(projectId, notebookId);
    }

    /**
     * Updates the current notebook ID for a project.
     * Used when switching notebooks within the same project.
     * @param projectId Project identifier
     * @param notebookId New current notebook ID
     */
    updateCurrentNotebookId(projectId: string, notebookId: string): void {
        this.currentNotebookId.set(projectId, notebookId);
    }
}
