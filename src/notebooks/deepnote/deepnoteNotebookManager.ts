import { injectable } from 'inversify';

import { IDeepnoteNotebookManager, ProjectIntegration } from '../types';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

/**
 * Centralized manager for tracking Deepnote notebook selections and project state.
 * Manages per-project state including current selections and project data caching.
 */
@injectable()
export class DeepnoteNotebookManager implements IDeepnoteNotebookManager {
    // Cached originals are keyed by projectId, then by notebookId, so sibling files
    // that share a single project.id do not clobber each other's cached project data.
    private readonly originalProjects = new Map<string /*projectId*/, Map<string /*notebookId*/, DeepnoteProject>>();

    /**
     * Retrieves the cached project data for an exact (projectId, notebookId) pair.
     * This performs an exact match only and never falls back to another sibling's
     * project — it returns undefined when that precise entry is not cached.
     * @param projectId Project identifier
     * @param notebookId Notebook identifier within the project
     * @returns The cached project data for that notebook, or undefined if not found
     */
    getProjectForNotebook(projectId: string, notebookId: string): DeepnoteProject | undefined {
        return this.originalProjects.get(projectId)?.get(notebookId);
    }

    /**
     * Stores the original project data for an exact (projectId, notebookId) pair.
     * This is used during deserialization to cache project data.
     * @param projectId Project identifier
     * @param notebookId Notebook identifier within the project
     * @param project Original project data to store
     */
    storeOriginalProject(projectId: string, notebookId: string, project: DeepnoteProject): void {
        // Deep clone to prevent mutations from affecting stored state.
        // Using structuredClone to handle circular references (e.g., in output metadata).
        const clonedProject = structuredClone(project);

        let notebookEntries = this.originalProjects.get(projectId);

        if (!notebookEntries) {
            notebookEntries = new Map<string, DeepnoteProject>();
            this.originalProjects.set(projectId, notebookEntries);
        }

        notebookEntries.set(notebookId, clonedProject);
    }

    /**
     * Updates the integrations list in the cached project data (cache-only).
     * Iterates every cached notebook entry under the project and updates each entry's
     * integrations.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if at least one cached entry was found and updated, `false` otherwise
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean {
        const notebookEntries = this.originalProjects.get(projectId);

        if (!notebookEntries || notebookEntries.size === 0) {
            return false;
        }

        for (const [notebookId, project] of notebookEntries) {
            const updatedProject = structuredClone(project);
            updatedProject.project.integrations = integrations;

            notebookEntries.set(notebookId, updatedProject);
        }

        return true;
    }
}
