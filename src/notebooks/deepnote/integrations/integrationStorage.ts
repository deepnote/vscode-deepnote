import { inject, injectable } from 'inversify';
import { EventEmitter } from 'vscode';

import { IEncryptedStorage } from '../../../platform/common/application/types';
import { IAsyncDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IntegrationConfig, IntegrationType } from './integrationTypes';

const INTEGRATION_SERVICE_NAME = 'deepnote-integrations';

/**
 * Storage service for integration configurations.
 * Uses VSCode's SecretStorage API to securely store credentials.
 * Storage is scoped to the user's machine and shared across all deepnote projects.
 */
@injectable()
export class IntegrationStorage {
    private readonly cache: Map<string, IntegrationConfig> = new Map();

    private cacheLoaded = false;

    private readonly _onDidChangeIntegrations = new EventEmitter<void>();

    public readonly onDidChangeIntegrations = this._onDidChangeIntegrations.event;

    constructor(
        @inject(IEncryptedStorage) private readonly encryptedStorage: IEncryptedStorage,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry
    ) {
        // Register for disposal when the extension deactivates
        asyncRegistry.push(this);
    }

    /**
     * Get all stored integration configurations
     */
    async getAll(): Promise<IntegrationConfig[]> {
        await this.ensureCacheLoaded();
        return Array.from(this.cache.values());
    }

    /**
     * Get a specific integration configuration by ID
     */
    async get(integrationId: string): Promise<IntegrationConfig | undefined> {
        await this.ensureCacheLoaded();
        return this.cache.get(integrationId);
    }

    /**
     * Get integration configuration for a specific project and integration
     * Note: Currently integrations are stored globally, not per-project,
     * so this method ignores the projectId parameter
     */
    async getIntegrationConfig(_projectId: string, integrationId: string): Promise<IntegrationConfig | undefined> {
        return this.get(integrationId);
    }

    /**
     * Get all integrations of a specific type
     */
    async getByType(type: IntegrationType): Promise<IntegrationConfig[]> {
        await this.ensureCacheLoaded();
        return Array.from(this.cache.values()).filter((config) => config.type === type);
    }

    /**
     * Save or update an integration configuration
     */
    async save(config: IntegrationConfig): Promise<void> {
        await this.ensureCacheLoaded();

        // Store the configuration as JSON in encrypted storage
        const configJson = JSON.stringify(config);
        await this.encryptedStorage.store(INTEGRATION_SERVICE_NAME, config.id, configJson);

        // Update cache
        this.cache.set(config.id, config);

        // Update the index
        await this.updateIndex();

        // Fire change event
        this._onDidChangeIntegrations.fire();
    }

    /**
     * Delete an integration configuration
     */
    async delete(integrationId: string): Promise<void> {
        await this.ensureCacheLoaded();

        // Remove from encrypted storage
        await this.encryptedStorage.store(INTEGRATION_SERVICE_NAME, integrationId, undefined);

        // Remove from cache
        this.cache.delete(integrationId);

        // Update the index
        await this.updateIndex();

        // Fire change event
        this._onDidChangeIntegrations.fire();
    }

    /**
     * Check if an integration exists
     */
    async exists(integrationId: string): Promise<boolean> {
        await this.ensureCacheLoaded();
        return this.cache.has(integrationId);
    }

    /**
     * Clear all integration configurations
     */
    async clear(): Promise<void> {
        await this.ensureCacheLoaded();

        // Delete all integrations from encrypted storage
        const integrationIds = Array.from(this.cache.keys());
        for (const id of integrationIds) {
            await this.encryptedStorage.store(INTEGRATION_SERVICE_NAME, id, undefined);
        }

        // Clear the index
        await this.encryptedStorage.store(INTEGRATION_SERVICE_NAME, 'index', undefined);

        // Clear cache
        this.cache.clear();
    }

    /**
     * Ensure the cache is loaded from storage
     */
    private async ensureCacheLoaded(): Promise<void> {
        if (this.cacheLoaded) {
            return;
        }

        // Load the index of integration IDs
        const indexJson = await this.encryptedStorage.retrieve(INTEGRATION_SERVICE_NAME, 'index');
        if (!indexJson) {
            this.cacheLoaded = true;
            return;
        }

        try {
            const integrationIds: string[] = JSON.parse(indexJson);

            // Load each integration configuration
            for (const id of integrationIds) {
                const configJson = await this.encryptedStorage.retrieve(INTEGRATION_SERVICE_NAME, id);
                if (configJson) {
                    try {
                        const config: IntegrationConfig = JSON.parse(configJson);
                        this.cache.set(id, config);
                    } catch (error) {
                        logger.error(`Failed to parse integration config for ${id}:`, error);
                    }
                }
            }
        } catch (error) {
            logger.error('Failed to parse integration index:', error);
        }

        this.cacheLoaded = true;
    }

    /**
     * Update the index of integration IDs in storage
     */
    private async updateIndex(): Promise<void> {
        const integrationIds = Array.from(this.cache.keys());
        const indexJson = JSON.stringify(integrationIds);
        await this.encryptedStorage.store(INTEGRATION_SERVICE_NAME, 'index', indexJson);
    }

    /**
     * Dispose of resources to prevent memory leaks
     */
    public dispose(): void {
        this._onDidChangeIntegrations.dispose();
    }
}
