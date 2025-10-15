// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { Uri, Memento } from 'vscode';
import { IExtensionContext } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';

/**
 * Manages the mapping between notebooks and their selected environments
 * Stores selections in workspace state for persistence across sessions
 */
@injectable()
export class DeepnoteNotebookEnvironmentMapper {
    private static readonly STORAGE_KEY = 'deepnote.notebookEnvironmentMappings';
    private readonly workspaceState: Memento;
    private mappings: Map<string, string>; // notebookUri.fsPath -> environmentId

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
    public getEnvironmentForNotebook(notebookUri: Uri): string | undefined {
        const key = notebookUri.fsPath;
        return this.mappings.get(key);
    }

    /**
     * Set the environment for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @param environmentId The environment ID
     */
    public async setEnvironmentForNotebook(notebookUri: Uri, environmentId: string): Promise<void> {
        const key = notebookUri.fsPath;
        this.mappings.set(key, environmentId);
        await this.saveMappings();
        logger.info(`Mapped notebook ${notebookUri.fsPath} to environment ${environmentId}`);
    }

    /**
     * Remove the environment mapping for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     */
    public async removeEnvironmentForNotebook(notebookUri: Uri): Promise<void> {
        const key = notebookUri.fsPath;
        this.mappings.delete(key);
        await this.saveMappings();
        logger.info(`Removed environment mapping for notebook ${notebookUri.fsPath}`);
    }

    /**
     * Get all notebooks using a specific environment
     * @param environmentId The environment ID
     * @returns Array of notebook URIs
     */
    public getNotebooksUsingEnvironment(environmentId: string): Uri[] {
        const notebooks: Uri[] = [];
        for (const [notebookPath, configId] of this.mappings.entries()) {
            if (configId === environmentId) {
                notebooks.push(Uri.file(notebookPath));
            }
        }
        return notebooks;
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
