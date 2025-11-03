// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { Uri, Memento } from 'vscode';
import { IExtensionContext } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { getDeepnoteProjectStorageKey } from '../../../platform/deepnote/deepnoteUriUtils.node';

/**
 * Manages the mapping between notebooks and their selected environments
 * Stores selections in workspace state for persistence across sessions
 */
@injectable()
export class DeepnoteNotebookEnvironmentMapper {
    private static readonly STORAGE_KEY = 'deepnote.notebookEnvironmentMappings';
    private readonly workspaceState: Memento;
    private mappings: Map<string, string>; // normalized notebook key -> environmentId

    constructor(@inject(IExtensionContext) context: IExtensionContext) {
        this.workspaceState = context.workspaceState;
        this.mappings = new Map();
        this.loadMappings();
    }

    /**
     * Get the environment ID selected for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @returns Environment ID, or undefined if not set
     */
    public getEnvironmentForNotebook(notebookUri: Uri, projectId?: string | null): string | undefined {
        const projectKey = getDeepnoteProjectStorageKey(notebookUri, projectId ?? undefined);
        return this.mappings.get(projectKey);
    }

    /**
     * Set the environment for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @param environmentId The environment ID
     */
    public async setEnvironmentForNotebook(
        notebookUri: Uri,
        projectId: string | null | undefined,
        environmentId: string
    ): Promise<void> {
        const projectKey = getDeepnoteProjectStorageKey(notebookUri, projectId ?? undefined);
        this.mappings.set(projectKey, environmentId);

        await this.saveMappings();
        logger.info(`Mapped project ${projectKey} to environment ${environmentId}`);
    }

    /**
     * Remove the environment mapping for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     */
    public async removeEnvironmentForNotebook(notebookUri: Uri, projectId?: string | null): Promise<void> {
        const projectKey = getDeepnoteProjectStorageKey(notebookUri, projectId ?? undefined);
        this.mappings.delete(projectKey);

        await this.saveMappings();
        logger.info(`Removed environment mapping for project ${projectKey}`);
    }

    /**
     * Remove the environment mapping for a normalized project key.
     */
    public async removeEnvironmentForProject(projectKey: string): Promise<void> {
        if (this.mappings.delete(projectKey)) {
            await this.saveMappings();
            logger.info(`Removed environment mapping for project key ${projectKey}`);
        }
    }

    /**
     * Get all project keys using a specific environment
     * @param environmentId The environment ID
     * @returns Array of project keys
     */
    public getProjectKeysUsingEnvironment(environmentId: string): string[] {
        const projectKeys: string[] = [];
        for (const [key, mappedEnvironmentId] of this.mappings.entries()) {
            if (mappedEnvironmentId === environmentId) {
                projectKeys.push(key);
            }
        }
        return projectKeys;
    }

    /**
     * Load mappings from workspace state
     */
    private loadMappings(): void {
        const stored = this.workspaceState.get<Record<string, string>>(DeepnoteNotebookEnvironmentMapper.STORAGE_KEY);
        if (stored) {
            this.mappings = new Map(Object.entries(stored));
            logger.info(`Loaded ${this.mappings.size} notebook-environment mappings`);
        }
    }

    /**
     * Save mappings to workspace state
     */
    private async saveMappings(): Promise<void> {
        const obj = Object.fromEntries(this.mappings.entries());
        await this.workspaceState.update(DeepnoteNotebookEnvironmentMapper.STORAGE_KEY, obj);
    }
}
