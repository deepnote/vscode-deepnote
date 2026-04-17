import { injectable } from 'inversify';

import { IDeepnoteNotebookManager, ProjectIntegration } from '../types';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

/**
 * Centralized manager for tracking Deepnote project state.
 * Manages per-project data caching and init notebook tracking.
 *
 * Cache keys are (projectId, notebookId) pairs so that split files sharing
 * a projectId but owning distinct notebooks don't clobber each other.
 */
@injectable()
export class DeepnoteNotebookManager implements IDeepnoteNotebookManager {
    private readonly originalProjects = new Map<string, Map<string, DeepnoteProject>>();
    private readonly projectsWithInitNotebookRun = new Set<string>();

    /**
     * Retrieves the original project data for a given project ID and optional notebook ID.
     * When `notebookId` is provided and matches a cached entry, that exact entry is returned.
     * Otherwise (or when no exact match exists), returns any cached entry for the projectId
     * to support project-wide reads (e.g. integrations list, project name) where any
     * cached notebook's project snapshot is equivalent.
     * @param projectId Project identifier
     * @param notebookId Optional notebook identifier
     * @returns Original project data or undefined if not found
     */
    getOriginalProject(projectId: string, notebookId?: string): DeepnoteProject | undefined {
        const notebookMap = this.originalProjects.get(projectId);

        if (!notebookMap) {
            return undefined;
        }

        if (notebookId !== undefined) {
            const exactMatch = notebookMap.get(notebookId);

            if (exactMatch) {
                return exactMatch;
            }
        }

        return notebookMap.values().next().value;
    }

    /**
     * Checks if the init notebook has already been run for a project.
     * @param projectId Project identifier
     * @returns True if init notebook has been run, false otherwise
     */
    hasInitNotebookBeenRun(projectId: string): boolean {
        return this.projectsWithInitNotebookRun.has(projectId);
    }

    /**
     * Marks the init notebook as having been run for a project.
     * @param projectId Project identifier
     */
    markInitNotebookAsRun(projectId: string): void {
        this.projectsWithInitNotebookRun.add(projectId);
    }

    /**
     * Stores the original project data for the given (projectId, notebookId) pair.
     * This is used during deserialization to cache project data.
     * @param projectId Project identifier
     * @param notebookId Notebook identifier within the project
     * @param project Original project data to store
     */
    storeOriginalProject(projectId: string, notebookId: string, project: DeepnoteProject): void {
        const clonedProject = structuredClone(project);
        let notebookMap = this.originalProjects.get(projectId);

        if (!notebookMap) {
            notebookMap = new Map<string, DeepnoteProject>();
            this.originalProjects.set(projectId, notebookMap);
        }

        notebookMap.set(notebookId, clonedProject);
    }

    /**
     * Updates the stored project data for the given (projectId, notebookId) pair.
     * Used during serialization where we need to cache the updated project state.
     * @param projectId Project identifier
     * @param notebookId Notebook identifier within the project
     * @param project Updated project data to store
     */
    updateOriginalProject(projectId: string, notebookId: string, project: DeepnoteProject): void {
        const clonedProject = structuredClone(project);
        let notebookMap = this.originalProjects.get(projectId);

        if (!notebookMap) {
            notebookMap = new Map<string, DeepnoteProject>();
            this.originalProjects.set(projectId, notebookMap);
        }

        notebookMap.set(notebookId, clonedProject);
    }

    /**
     * Updates the integrations list in the project data.
     * This modifies every cached entry for the project to reflect changes in configured integrations.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if at least one cached entry was found and updated, `false` if no entries exist
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean {
        const notebookMap = this.originalProjects.get(projectId);

        if (!notebookMap || notebookMap.size === 0) {
            return false;
        }

        for (const [notebookId, project] of notebookMap.entries()) {
            const updatedProject = structuredClone(project);
            updatedProject.project.integrations = integrations;
            notebookMap.set(notebookId, updatedProject);
        }

        return true;
    }
}
