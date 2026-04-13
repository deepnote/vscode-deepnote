import { injectable } from 'inversify';

import { IDeepnoteNotebookManager, ProjectIntegration } from '../types';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

/**
 * Centralized manager for tracking Deepnote project state.
 * Manages per-project data caching and init notebook tracking.
 */
@injectable()
export class DeepnoteNotebookManager implements IDeepnoteNotebookManager {
    private readonly originalProjects = new Map<string, DeepnoteProject>();
    private readonly projectsWithInitNotebookRun = new Set<string>();

    /**
     * Retrieves the original project data for a given project ID.
     * @param projectId Project identifier
     * @returns Original project data or undefined if not found
     */
    getOriginalProject(projectId: string): DeepnoteProject | undefined {
        return this.originalProjects.get(projectId);
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
     * Stores the original project data.
     * This is used during deserialization to cache project data.
     * @param projectId Project identifier
     * @param project Original project data to store
     */
    storeOriginalProject(projectId: string, project: DeepnoteProject): void {
        const clonedProject = structuredClone(project);
        this.originalProjects.set(projectId, clonedProject);
    }

    /**
     * Updates the stored project data.
     * Used during serialization where we need to cache the updated project state.
     * @param projectId Project identifier
     * @param project Updated project data to store
     */
    updateOriginalProject(projectId: string, project: DeepnoteProject): void {
        const clonedProject = structuredClone(project);
        this.originalProjects.set(projectId, clonedProject);
    }

    /**
     * Updates the integrations list in the project data.
     * This modifies the stored project to reflect changes in configured integrations.
     *
     * @param projectId - Project identifier
     * @param integrations - Array of integration metadata to store in the project
     * @returns `true` if the project was found and updated successfully, `false` if the project does not exist
     */
    updateProjectIntegrations(projectId: string, integrations: ProjectIntegration[]): boolean {
        const project = this.originalProjects.get(projectId);

        if (!project) {
            return false;
        }

        const updatedProject = structuredClone(project);
        updatedProject.project.integrations = integrations;
        this.originalProjects.set(projectId, updatedProject);

        return true;
    }
}
