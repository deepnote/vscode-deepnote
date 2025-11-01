import { inject, injectable } from 'inversify';
import { EventEmitter } from 'vscode';

import { IEncryptedStorage } from '../../common/application/types';
import { IAsyncDisposableRegistry } from '../../common/types';
import { logger } from '../../logging';
import { IIntegrationStorage } from './types';
import { upgradeLegacyIntegrationConfig } from './legacyIntegrationConfigUtils';
import {
    DatabaseIntegrationConfig,
    databaseIntegrationTypes,
    databaseMetadataSchemasByType
} from '@deepnote/database-integrations';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';

const INTEGRATION_SERVICE_NAME = 'deepnote-integrations';

// NOTE: We need a way to upgrade existing configurations to the new format of deepnote/database-integrations.
type VersionedDatabaseIntegrationConfig = DatabaseIntegrationConfig & { version: 1 };

function storeEncryptedIntegrationConfig(
    encryptedStorage: IEncryptedStorage,
    integrationId: string,
    config: VersionedDatabaseIntegrationConfig
): Promise<void> {
    return encryptedStorage.store(INTEGRATION_SERVICE_NAME, integrationId, JSON.stringify(config));
}

/**
 * Storage service for integration configurations.
 * Uses VSCode's SecretStorage API to securely store credentials.
 * Storage is scoped to the user's machine and shared across all deepnote projects.
 */
@injectable()
export class IntegrationStorage implements IIntegrationStorage {
    private readonly cache: Map<string, DatabaseIntegrationConfig> = new Map();

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
     * Get all stored integration configurations.
     */
    async getAll(): Promise<DatabaseIntegrationConfig[]> {
        await this.ensureCacheLoaded();
        return Array.from(this.cache.values());
    }

    /**
     * Get a specific integration configuration by ID
     */
    async getIntegrationConfig(integrationId: string): Promise<DatabaseIntegrationConfig | undefined> {
        await this.ensureCacheLoaded();
        return this.cache.get(integrationId);
    }

    /**
     * Get integration configuration for a specific project and integration
     * Note: Currently integrations are stored globally, not per-project,
     * so this method ignores the projectId parameter
     */
    async getProjectIntegrationConfig(
        _projectId: string,
        integrationId: string
    ): Promise<DatabaseIntegrationConfig | undefined> {
        return this.getIntegrationConfig(integrationId);
    }

    /**
     * Save or update an integration configuration
     */
    async save(config: DatabaseIntegrationConfig): Promise<void> {
        if (config.type === 'pandas-dataframe' || config.id === DATAFRAME_SQL_INTEGRATION_ID) {
            logger.warn(`IntegrationStorage: Skipping save for internal DuckDB integration ${config.id}`);
            return;
        }

        await this.ensureCacheLoaded();

        // Store the configuration as JSON in encrypted storage
        await storeEncryptedIntegrationConfig(this.encryptedStorage, config.id, { ...config, version: 1 });
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

        // Notify listeners
        this._onDidChangeIntegrations.fire();
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
            const idsToDelete: string[] = [];

            // Load each integration configuration
            for (const id of integrationIds) {
                if (id === DATAFRAME_SQL_INTEGRATION_ID) {
                    continue;
                }

                const configJson = await this.encryptedStorage.retrieve(INTEGRATION_SERVICE_NAME, id);
                if (configJson) {
                    try {
                        const parsedData = JSON.parse(configJson);

                        // Check if this is a legacy config (missing 'version' field)
                        if (!('version' in parsedData)) {
                            logger.info(`Upgrading legacy integration config for ${id}`);

                            // Attempt to upgrade the legacy config
                            const upgradedConfig = await upgradeLegacyIntegrationConfig(parsedData);

                            if (upgradedConfig) {
                                if (upgradedConfig.type === 'pandas-dataframe') {
                                    logger.warn(`IntegrationStorage: Skipping internal DuckDB integration ${id}`);
                                    continue;
                                }

                                // Successfully upgraded - save the new config
                                logger.info(`Successfully upgraded integration config for ${id}`);
                                await storeEncryptedIntegrationConfig(this.encryptedStorage, id, {
                                    ...upgradedConfig,
                                    version: 1
                                });
                                this.cache.set(id, upgradedConfig);
                            } else {
                                // Upgrade failed - mark for deletion
                                logger.warn(`Failed to upgrade integration ${id}, marking for deletion`);
                                idsToDelete.push(id);
                            }
                        } else {
                            // Already versioned config - validate against current schema
                            const { version: _version, ...rawConfig } = parsedData;
                            const config =
                                databaseIntegrationTypes.includes(rawConfig.type) &&
                                rawConfig.type !== 'pandas-dataframe'
                                    ? (rawConfig as DatabaseIntegrationConfig)
                                    : null;
                            const validMetadata = config
                                ? databaseMetadataSchemasByType[config.type].safeParse(config.metadata).data
                                : null;
                            if (config && validMetadata) {
                                this.cache.set(
                                    id,
                                    // NOTE: We must cast here because there is no union-wide schema parser at the moment.
                                    { ...config, metadata: validMetadata } as DatabaseIntegrationConfig
                                );
                            } else {
                                logger.warn(`Invalid integration config for ${id}, marking for deletion`);
                                idsToDelete.push(id);
                            }
                        }
                    } catch (error) {
                        logger.error(`Failed to parse integration config for ${id}:`, error);
                        // Mark corrupted configs for deletion
                        idsToDelete.push(id);
                    }
                }
            }

            // Delete any configs that failed to upgrade or were corrupted
            if (idsToDelete.length > 0) {
                logger.info(`Deleting ${idsToDelete.length} invalid integration config(s)`);
                for (const id of idsToDelete) {
                    await this.encryptedStorage.store(INTEGRATION_SERVICE_NAME, id, undefined);
                }
                // Update the index to remove deleted IDs
                await this.updateIndex();
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
