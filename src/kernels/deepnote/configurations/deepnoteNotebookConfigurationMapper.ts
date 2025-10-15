// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { Uri, Memento } from 'vscode';
import { IExtensionContext } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';

/**
 * Manages the mapping between notebooks and their selected configurations
 * Stores selections in workspace state for persistence across sessions
 */
@injectable()
export class DeepnoteNotebookConfigurationMapper {
    private static readonly STORAGE_KEY = 'deepnote.notebookConfigurationMappings';
    private readonly workspaceState: Memento;
    private mappings: Map<string, string>; // notebookUri.fsPath -> configurationId

    constructor(@inject(IExtensionContext) context: IExtensionContext) {
        this.workspaceState = context.workspaceState;
        this.mappings = new Map();
        this.loadMappings();
    }

    /**
     * Get the configuration ID selected for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @returns Configuration ID, or undefined if not set
     */
    public getConfigurationForNotebook(notebookUri: Uri): string | undefined {
        const key = notebookUri.fsPath;
        return this.mappings.get(key);
    }

    /**
     * Set the configuration for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @param configurationId The configuration ID
     */
    public async setConfigurationForNotebook(notebookUri: Uri, configurationId: string): Promise<void> {
        const key = notebookUri.fsPath;
        this.mappings.set(key, configurationId);
        await this.saveMappings();
        logger.info(`Mapped notebook ${notebookUri.fsPath} to configuration ${configurationId}`);
    }

    /**
     * Remove the configuration mapping for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     */
    public async removeConfigurationForNotebook(notebookUri: Uri): Promise<void> {
        const key = notebookUri.fsPath;
        this.mappings.delete(key);
        await this.saveMappings();
        logger.info(`Removed configuration mapping for notebook ${notebookUri.fsPath}`);
    }

    /**
     * Get all notebooks using a specific configuration
     * @param configurationId The configuration ID
     * @returns Array of notebook URIs
     */
    public getNotebooksUsingConfiguration(configurationId: string): Uri[] {
        const notebooks: Uri[] = [];
        for (const [notebookPath, configId] of this.mappings.entries()) {
            if (configId === configurationId) {
                notebooks.push(Uri.file(notebookPath));
            }
        }
        return notebooks;
    }

    /**
     * Load mappings from workspace state
     */
    private loadMappings(): void {
        const stored = this.workspaceState.get<Record<string, string>>(DeepnoteNotebookConfigurationMapper.STORAGE_KEY);
        if (stored) {
            this.mappings = new Map(Object.entries(stored));
            logger.info(`Loaded ${this.mappings.size} notebook-configuration mappings`);
        }
    }

    /**
     * Save mappings to workspace state
     */
    private async saveMappings(): Promise<void> {
        const obj = Object.fromEntries(this.mappings.entries());
        await this.workspaceState.update(DeepnoteNotebookConfigurationMapper.STORAGE_KEY, obj);
    }
}
