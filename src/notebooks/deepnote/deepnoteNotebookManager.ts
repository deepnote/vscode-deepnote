import { injectable } from 'inversify';

import { IDeepnoteNotebookManager, ProjectIntegration } from '../types';
import type { DeepnoteProject } from '../../platform/deepnote/deepnoteTypes';

const pendingNotebookResolutionTtlMs = 60_000;

interface PendingNotebookResolution {
    notebookId: string;
    queuedAt: number;
}

/**
 * Centralized manager for tracking Deepnote notebook selections and project state.
 * Manages per-project state including current selections and project data caching.
 */
@injectable()
export class DeepnoteNotebookManager implements IDeepnoteNotebookManager {
    private readonly currentNotebookId = new Map<string, string>();
    private readonly originalProjects = new Map<string, DeepnoteProject>();
    private readonly pendingNotebookResolutions = new Map<string, PendingNotebookResolution[]>();
    private readonly projectsWithInitNotebookRun = new Set<string>();

    /**
     * Consumes the next short-lived notebook resolution hint for a project.
     * These hints are queued immediately before operations that trigger a
     * deserialize without explicit URI context.
     */
    consumePendingNotebookResolution(projectId: string): string | undefined {
        const pendingResolutions = this.getValidPendingNotebookResolutions(projectId);
        const nextResolution = pendingResolutions.shift();

        if (pendingResolutions.length > 0) {
            this.pendingNotebookResolutions.set(projectId, pendingResolutions);
        } else {
            this.pendingNotebookResolutions.delete(projectId);
        }

        return nextResolution?.notebookId;
    }

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
     * Queues a short-lived notebook resolution hint for the next deserialize.
     *
     * @param projectId - The project ID that identifies the Deepnote project
     * @param notebookId - The notebook ID the next deserialize should resolve to
     */
    queueNotebookResolution(projectId: string, notebookId: string): void {
        const pendingResolutions = this.getValidPendingNotebookResolutions(projectId);

        pendingResolutions.push({
            notebookId,
            queuedAt: Date.now()
        });

        this.pendingNotebookResolutions.set(projectId, pendingResolutions);
    }

    /**
     * Stores the original project data and sets the initial current notebook.
     * This is used during deserialization to cache project data and track the active notebook.
     * @param projectId Project identifier
     * @param project Original project data to store
     * @param notebookId Initial notebook ID to set as current
     */
    storeOriginalProject(projectId: string, project: DeepnoteProject, notebookId: string): void {
        // Deep clone to prevent mutations from affecting stored state
        // This is critical for multi-notebook projects where multiple notebooks
        // share the same stored project reference
        // Using structuredClone to handle circular references (e.g., in output metadata)
        const clonedProject = structuredClone(project);

        this.originalProjects.set(projectId, clonedProject);
        this.currentNotebookId.set(projectId, notebookId);
    }

    /**
     * Updates the stored project data without changing the current notebook selection.
     * Used during serialization where we need to cache the updated project state
     * but must not alter notebook routing for other open notebooks.
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

        const currentNotebookId = this.currentNotebookId.get(projectId);

        if (currentNotebookId) {
            this.storeOriginalProject(projectId, updatedProject, currentNotebookId);
        } else {
            this.originalProjects.set(projectId, updatedProject);
        }

        return true;
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

    private getValidPendingNotebookResolutions(projectId: string): PendingNotebookResolution[] {
        const cutoffTime = Date.now() - pendingNotebookResolutionTtlMs;
        const pendingResolutions = (this.pendingNotebookResolutions.get(projectId) ?? []).filter(
            (resolution) => resolution.queuedAt >= cutoffTime
        );

        if (pendingResolutions.length === 0) {
            this.pendingNotebookResolutions.delete(projectId);
            return [];
        }

        return pendingResolutions;
    }
}
