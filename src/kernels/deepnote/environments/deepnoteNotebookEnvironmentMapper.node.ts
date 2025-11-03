// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { Uri, Memento } from 'vscode';
import { IExtensionContext } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import {
    getDeepnoteNotebookStorageKey,
    getLegacyDeepnoteNotebookStorageKey
} from '../../../platform/deepnote/deepnoteUriUtils';

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
    public getEnvironmentForNotebook(notebookUri: Uri): string | undefined {
        const key = getDeepnoteNotebookStorageKey(notebookUri);
        const environmentId = this.mappings.get(key);
        if (environmentId !== undefined) {
            return environmentId;
        }

        // Backwards compatibility with legacy keys that only used fsPath.
        const legacyKey = getLegacyDeepnoteNotebookStorageKey(notebookUri);
        const legacyEnvironment = this.mappings.get(legacyKey);
        if (legacyEnvironment !== undefined) {
            // upgrade in memory so subsequent lookups use the normalized key
            this.mappings.delete(legacyKey);
            this.mappings.set(key, legacyEnvironment);
        }

        return legacyEnvironment;
    }

    /**
     * Set the environment for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @param environmentId The environment ID
     */
    public async setEnvironmentForNotebook(notebookUri: Uri, environmentId: string): Promise<void> {
        const key = getDeepnoteNotebookStorageKey(notebookUri);
        this.mappings.set(key, environmentId);

        const legacyKey = getLegacyDeepnoteNotebookStorageKey(notebookUri);
        if (legacyKey !== key) {
            this.mappings.delete(legacyKey);
        }
        await this.saveMappings();
        logger.info(`Mapped notebook ${notebookUri.fsPath} to environment ${environmentId}`);
    }

    /**
     * Remove the environment mapping for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     */
    public async removeEnvironmentForNotebook(notebookUri: Uri): Promise<void> {
        const key = getDeepnoteNotebookStorageKey(notebookUri);
        this.mappings.delete(key);

        const legacyKey = getLegacyDeepnoteNotebookStorageKey(notebookUri);
        if (legacyKey !== key) {
            this.mappings.delete(legacyKey);
        }
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
        for (const [notebookKey, configId] of this.mappings.entries()) {
            if (configId !== environmentId) {
                continue;
            }

            try {
                if (notebookKey.includes('://')) {
                    notebooks.push(Uri.parse(notebookKey));
                } else {
                    notebooks.push(Uri.file(notebookKey));
                }
            } catch (error) {
                logger.warn(`Failed to parse notebook key '${notebookKey}' while listing environment mappings`, error);
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
