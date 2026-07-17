import { injectable } from 'inversify';
import type { DeepnoteFile } from '@deepnote/blocks';

import { IDeepnoteNotebookManager, ProjectIntegration } from '../types';

/**
 * Centralized manager for tracking Deepnote notebook selections and project state.
 * Manages per-project state including current selections and project data caching.
 */
@injectable()
export class DeepnoteNotebookManager implements IDeepnoteNotebookManager {
    // Cached originals are keyed by projectId, then by notebookId, so sibling files
    // that share a single project.id do not clobber each other's cached project data.
    private readonly originalProjects = new Map<string /*projectId*/, Map<string /*notebookId*/, DeepnoteFile>>();

    /**
     * Retrieves the cached project data for an exact (projectId, notebookId) pair; never falls
     * back to another sibling's project, returning undefined when that entry is not cached.
     */
    getProjectForNotebook(projectId: string, notebookId: string): DeepnoteFile | undefined {
        return this.originalProjects.get(projectId)?.get(notebookId);
    }

    /** Stores the original project data for an exact (projectId, notebookId) pair. */
    storeOriginalProject(projectId: string, notebookId: string, project: DeepnoteFile): void {
        // structuredClone to prevent mutations affecting stored state and handle circular refs.
        const clonedProject = structuredClone(project);

        let notebookEntries = this.originalProjects.get(projectId);

        if (!notebookEntries) {
            notebookEntries = new Map<string, DeepnoteFile>();
            this.originalProjects.set(projectId, notebookEntries);
        }

        notebookEntries.set(notebookId, clonedProject);
    }

    /**
     * Updates the integrations list across every cached notebook entry under the project (cache-only).
     * @returns `true` if at least one cached entry was updated, `false` otherwise.
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean {
        const notebookEntries = this.originalProjects.get(projectId);

        if (!notebookEntries || notebookEntries.size === 0) {
            return false;
        }

        for (const [notebookId, project] of notebookEntries) {
            const updatedProject = structuredClone(project);
            updatedProject.project.integrations = structuredClone(integrations);

            notebookEntries.set(notebookId, updatedProject);
        }

        return true;
    }
}
