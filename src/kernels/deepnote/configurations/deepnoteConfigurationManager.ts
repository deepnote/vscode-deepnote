import { injectable, inject } from 'inversify';
import { EventEmitter, Uri } from 'vscode';
import { generateUuid as uuid } from '../../../platform/common/uuid';
import { IExtensionContext } from '../../../platform/common/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { logger } from '../../../platform/logging';
import { DeepnoteConfigurationStorage } from './deepnoteConfigurationStorage';
import {
    CreateKernelConfigurationOptions,
    DeepnoteKernelConfiguration,
    DeepnoteKernelConfigurationWithStatus,
    KernelConfigurationStatus
} from './deepnoteKernelConfiguration';
import { IDeepnoteServerStarter, IDeepnoteToolkitInstaller } from '../types';

/**
 * Manager for Deepnote kernel configurations.
 * Handles CRUD operations and server lifecycle management.
 */
@injectable()
export class DeepnoteConfigurationManager implements IExtensionSyncActivationService {
    private configurations: Map<string, DeepnoteKernelConfiguration> = new Map();
    private readonly _onDidChangeConfigurations = new EventEmitter<void>();
    public readonly onDidChangeConfigurations = this._onDidChangeConfigurations.event;

    constructor(
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(DeepnoteConfigurationStorage) private readonly storage: DeepnoteConfigurationStorage,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter
    ) {}

    /**
     * Activate the service (called by VS Code on extension activation)
     */
    public activate(): void {
        this.initialize().catch((error) => {
            logger.error('Failed to activate configuration manager', error);
        });
    }

    /**
     * Initialize the manager by loading configurations from storage
     */
    public async initialize(): Promise<void> {
        try {
            const configs = await this.storage.loadConfigurations();
            this.configurations.clear();

            for (const config of configs) {
                this.configurations.set(config.id, config);
            }

            logger.info(`Initialized configuration manager with ${this.configurations.size} configurations`);
        } catch (error) {
            logger.error('Failed to initialize configuration manager', error);
        }
    }

    /**
     * Create a new kernel configuration
     */
    public async createConfiguration(options: CreateKernelConfigurationOptions): Promise<DeepnoteKernelConfiguration> {
        const id = uuid();
        const venvPath = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', id);

        const configuration: DeepnoteKernelConfiguration = {
            id,
            name: options.name,
            pythonInterpreter: options.pythonInterpreter,
            venvPath,
            createdAt: new Date(),
            lastUsedAt: new Date(),
            packages: options.packages,
            description: options.description
        };

        this.configurations.set(id, configuration);
        await this.persistConfigurations();
        this._onDidChangeConfigurations.fire();

        logger.info(`Created new kernel configuration: ${configuration.name} (${id})`);
        return configuration;
    }

    /**
     * Get all configurations
     */
    public listConfigurations(): DeepnoteKernelConfiguration[] {
        return Array.from(this.configurations.values());
    }

    /**
     * Get a specific configuration by ID
     */
    public getConfiguration(id: string): DeepnoteKernelConfiguration | undefined {
        return this.configurations.get(id);
    }

    /**
     * Get configuration with status information
     */
    public getConfigurationWithStatus(id: string): DeepnoteKernelConfigurationWithStatus | undefined {
        const config = this.configurations.get(id);
        if (!config) {
            return undefined;
        }

        let status: KernelConfigurationStatus;
        if (config.serverInfo) {
            status = KernelConfigurationStatus.Running;
        } else {
            status = KernelConfigurationStatus.Stopped;
        }

        return {
            ...config,
            status
        };
    }

    /**
     * Update a configuration's metadata
     */
    public async updateConfiguration(
        id: string,
        updates: Partial<Pick<DeepnoteKernelConfiguration, 'name' | 'packages' | 'description'>>
    ): Promise<void> {
        const config = this.configurations.get(id);
        if (!config) {
            throw new Error(`Configuration not found: ${id}`);
        }

        if (updates.name !== undefined) {
            config.name = updates.name;
        }
        if (updates.packages !== undefined) {
            config.packages = updates.packages;
        }
        if (updates.description !== undefined) {
            config.description = updates.description;
        }

        await this.persistConfigurations();
        this._onDidChangeConfigurations.fire();

        logger.info(`Updated configuration: ${config.name} (${id})`);
    }

    /**
     * Delete a configuration
     */
    public async deleteConfiguration(id: string): Promise<void> {
        const config = this.configurations.get(id);
        if (!config) {
            throw new Error(`Configuration not found: ${id}`);
        }

        // Stop the server if running
        if (config.serverInfo) {
            await this.stopServer(id);
        }

        this.configurations.delete(id);
        await this.persistConfigurations();
        this._onDidChangeConfigurations.fire();

        logger.info(`Deleted configuration: ${config.name} (${id})`);
    }

    /**
     * Start the Jupyter server for a configuration
     */
    public async startServer(id: string): Promise<void> {
        const config = this.configurations.get(id);
        if (!config) {
            throw new Error(`Configuration not found: ${id}`);
        }

        if (config.serverInfo) {
            logger.info(`Server already running for configuration: ${config.name} (${id})`);
            return;
        }

        try {
            logger.info(`Starting server for configuration: ${config.name} (${id})`);

            // First ensure venv is created and toolkit is installed
            await this.toolkitInstaller.ensureVenvAndToolkit(config.pythonInterpreter, config.venvPath);

            // Install additional packages if specified
            if (config.packages && config.packages.length > 0) {
                await this.toolkitInstaller.installAdditionalPackages(config.venvPath, config.packages);
            }

            // Start the Jupyter server
            const serverInfo = await this.serverStarter.startServer(config.pythonInterpreter, config.venvPath, id);

            config.serverInfo = serverInfo;
            config.lastUsedAt = new Date();

            await this.persistConfigurations();
            this._onDidChangeConfigurations.fire();

            logger.info(`Server started successfully for configuration: ${config.name} (${id})`);
        } catch (error) {
            logger.error(`Failed to start server for configuration: ${config.name} (${id})`, error);
            throw error;
        }
    }

    /**
     * Stop the Jupyter server for a configuration
     */
    public async stopServer(id: string): Promise<void> {
        const config = this.configurations.get(id);
        if (!config) {
            throw new Error(`Configuration not found: ${id}`);
        }

        if (!config.serverInfo) {
            logger.info(`No server running for configuration: ${config.name} (${id})`);
            return;
        }

        try {
            logger.info(`Stopping server for configuration: ${config.name} (${id})`);

            await this.serverStarter.stopServer(id);

            config.serverInfo = undefined;

            await this.persistConfigurations();
            this._onDidChangeConfigurations.fire();

            logger.info(`Server stopped successfully for configuration: ${config.name} (${id})`);
        } catch (error) {
            logger.error(`Failed to stop server for configuration: ${config.name} (${id})`, error);
            throw error;
        }
    }

    /**
     * Restart the Jupyter server for a configuration
     */
    public async restartServer(id: string): Promise<void> {
        logger.info(`Restarting server for configuration: ${id}`);
        await this.stopServer(id);
        await this.startServer(id);
    }

    /**
     * Update the last used timestamp for a configuration
     */
    public async updateLastUsed(id: string): Promise<void> {
        const config = this.configurations.get(id);
        if (!config) {
            return;
        }

        config.lastUsedAt = new Date();
        await this.persistConfigurations();
    }

    /**
     * Persist all configurations to storage
     */
    private async persistConfigurations(): Promise<void> {
        const configs = Array.from(this.configurations.values());
        await this.storage.saveConfigurations(configs);
    }

    /**
     * Dispose of all resources
     */
    public dispose(): void {
        this._onDidChangeConfigurations.dispose();
    }
}
