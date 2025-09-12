import { injectable } from 'inversify';

import { IDeepnoteNotebookManager } from '../types';
import type { DeepnoteProject } from './deepnoteTypes';

/**
 * Centralized manager for tracking Deepnote notebook selections and project state.
 * Manages per-project state including current selections and project data caching.
 */
@injectable()
export class DeepnoteNotebookManager implements IDeepnoteNotebookManager {
    private readonly currentNotebookId = new Map<string, string>();
    private readonly originalProjects = new Map<string, DeepnoteProject>();
    private readonly selectedNotebookByProject = new Map<string, string>();

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
     * Gets the selected notebook ID for a specific project.
     * @param projectId Project identifier
     * @returns Selected notebook ID or undefined if not set
     */
    getTheSelectedNotebookForAProject(projectId: string): string | undefined {
        return this.selectedNotebookByProject.get(projectId);
    }

    /**
     * Associates a notebook ID with a project to remember user's notebook selection.
     * When a Deepnote project contains multiple notebooks, this mapping persists the user's
     * choice so we can automatically open the same notebook on subsequent file opens.
     *
     * @param projectId - The project ID that identifies the Deepnote project
     * @param notebookId - The ID of the selected notebook within the project
     */
    selectNotebookForProject(projectId: string, notebookId: string): void {
        this.selectedNotebookByProject.set(projectId, notebookId);
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
