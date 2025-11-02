import { injectable, inject, named, optional } from 'inversify';
import { EventEmitter, Uri, CancellationToken, l10n } from 'vscode';
import { generateUuid as uuid } from '../../../platform/common/uuid';
import { IConfigurationService, IExtensionContext, IOutputChannel } from '../../../platform/common/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { logger } from '../../../platform/logging';
import { DeepnoteEnvironmentStorage } from './deepnoteEnvironmentStorage.node';
import { CreateDeepnoteEnvironmentOptions, DeepnoteEnvironment } from './deepnoteEnvironment';
import {
    IDeepnoteEnvironmentManager,
    IDeepnoteServerProvider,
    IDeepnoteServerStarter,
    IDeepnoteToolkitInstaller
} from '../types';
import { Cancellation } from '../../../platform/common/cancellation';
import { STANDARD_OUTPUT_CHANNEL } from '../../../platform/common/constants';
import { IJupyterRequestAgentCreator, IJupyterRequestCreator } from '../../jupyter/types';

/**
 * Manager for Deepnote kernel environments.
 * Handles CRUD operations and server lifecycle management.
 */
@injectable()
export class DeepnoteEnvironmentManager implements IExtensionSyncActivationService, IDeepnoteEnvironmentManager {
    // Track server handles per notebook URI for cleanup
    // private readonly notebookServerHandles = new Map<string, string>();

    private environments: Map<string, DeepnoteEnvironment> = new Map();
    private environmentServers: Map<string, Uri[]> = new Map();
    // private serversByFile: Map<string, DeepnoteServerInfo> = new Map();
    private tmpStartingServers: Map<string, boolean> = new Map();
    private readonly _onDidChangeEnvironments = new EventEmitter<void>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;
    private initializationPromise: Promise<void> | undefined;

    constructor(
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(DeepnoteEnvironmentStorage) private readonly storage: DeepnoteEnvironmentStorage,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter,
        @inject(IDeepnoteServerProvider) private readonly serverProvider: IDeepnoteServerProvider,
        @inject(IJupyterRequestCreator) private readonly requestCreator: IJupyterRequestCreator,
        @inject(IJupyterRequestAgentCreator)
        @optional()
        private readonly requestAgentCreator: IJupyterRequestAgentCreator | undefined,
        @inject(IConfigurationService) private readonly configService: IConfigurationService,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel
    ) {}

    /**
     * Activate the service (called by VS Code on extension activation)
     */
    public activate(): void {
        // Store the initialization promise so other components can wait for it
        this.initializationPromise = this.initialize().catch((error) => {
            logger.error('Failed to activate environment manager', error);
            const msg = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(l10n.t('Failed to activate environment manager: {0}', msg));
        });
    }

    /**
     * Initialize the manager by loading environments from storage
     */
    public async initialize(): Promise<void> {
        try {
            const configs = await this.storage.loadEnvironments();
            this.environments.clear();

            for (const config of configs) {
                this.environments.set(config.id, config);
            }

            logger.info(`Initialized environment manager with ${this.environments.size} environments`);

            // Fire event to notify tree view of loaded environments
            this._onDidChangeEnvironments.fire();
        } catch (error) {
            logger.error('Failed to initialize environment manager', error);
        }
    }

    /**
     * Wait for initialization to complete
     */
    public async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
    }

    /**
     * Create a new kernel environment
     */
    public async createEnvironment(
        options: CreateDeepnoteEnvironmentOptions,
        token?: CancellationToken
    ): Promise<DeepnoteEnvironment> {
        Cancellation.throwIfCanceled(token);

        const id = uuid();
        const venvPath = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', id);

        const environment: DeepnoteEnvironment = {
            id,
            name: options.name,
            pythonInterpreter: options.pythonInterpreter,
            venvPath,
            createdAt: new Date(),
            lastUsedAt: new Date(),
            packages: options.packages,
            description: options.description
        };

        Cancellation.throwIfCanceled(token);

        this.environments.set(id, environment);
        await this.persistEnvironments();
        this._onDidChangeEnvironments.fire();

        logger.info(`Created new environment: ${environment.name} (${id})`);
        return environment;
    }

    /**
     * Get all environments
     */
    public listEnvironments(): DeepnoteEnvironment[] {
        return Array.from(this.environments.values());
    }

    /**
     * Get a specific environment by ID
     */
    public getEnvironment(id: string): DeepnoteEnvironment | undefined {
        return this.environments.get(id);
    }

    /**
     * Update an environment's metadata
     */
    public async updateEnvironment(
        id: string,
        updates: Partial<Pick<DeepnoteEnvironment, 'name' | 'packages' | 'description'>>
    ): Promise<void> {
        const config = this.environments.get(id);
        if (!config) {
            throw new Error(l10n.t('Environment not found: {0}', id));
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

        await this.persistEnvironments();
        this._onDidChangeEnvironments.fire();

        logger.info(`Updated environment: ${config.name} (${id})`);
    }

    /**
     * Delete an environment
     */
    public async deleteEnvironment(id: string, token?: CancellationToken): Promise<void> {
        Cancellation.throwIfCanceled(token);

        const config = this.environments.get(id);
        if (!config) {
            throw new Error(`Environment not found: ${id}`);
        }

        // // Stop the server if running
        // if (config.serverInfo) {
        //     await this.stopServer(id, token);
        // }
        for (const fileKey of this.environmentServers.get(id) ?? []) {
            await this.serverStarter.stopServer(fileKey, token);
            Cancellation.throwIfCanceled(token);
        }

        Cancellation.throwIfCanceled(token);

        this.environments.delete(id);
        await this.persistEnvironments();
        this._onDidChangeEnvironments.fire();

        logger.info(`Deleted environment: ${config.name} (${id})`);
    }

    // /**
    //  * Start the Jupyter server for an environment
    //  */
    // // public async startServer(id: string, token?: CancellationToken): Promise<void> {
    // public async startServer(id: string, deepnoteFileUri: Uri, token?: CancellationToken): Promise<void> {
    //     const config = this.environments.get(id);
    //     if (!config) {
    //         throw new Error(`Environment not found: ${id}`);
    //     }

    //     this.tmpStartingServers.set(id, true);
    //     this._onDidChangeEnvironments.fire();

    //     try {
    //         logger.info(`Ensuring server is running for environment: ${config.name} (${id})`);

    //         // First ensure venv is created and toolkit is installed
    //         const { pythonInterpreter, toolkitVersion } = await this.toolkitInstaller.ensureVenvAndToolkit(
    //             config.pythonInterpreter,
    //             config.venvPath,
    //             token
    //         );

    //         // Install additional packages if specified
    //         if (config.packages && config.packages.length > 0) {
    //             await this.toolkitInstaller.installAdditionalPackages(config.venvPath, config.packages, token);
    //         }

    //         // Start the Jupyter server (serverStarter is idempotent - returns existing if running)
    //         // IMPORTANT: Always call this to ensure we get the current server info
    //         // Don't return early based on config.serverInfo - it may be stale!
    //         const serverInfo = await this.serverStarter.startServer(
    //             pythonInterpreter,
    //             config.venvPath,
    //             id,
    //             deepnoteFileUri,
    //             token
    //         );

    //         config.pythonInterpreter = pythonInterpreter;
    //         config.toolkitVersion = toolkitVersion;
    //         config.serverInfo = serverInfo;
    //         config.lastUsedAt = new Date();

    //         await this.persistEnvironments();
    //         this._onDidChangeEnvironments.fire();

    //         logger.info(`Server running for environment: ${config.name} (${id}) at ${serverInfo.url}`);
    //     } catch (error) {
    //         logger.error(`Failed to start server for environment: ${config.name} (${id})`, error);
    //         throw error;
    //     } finally {
    //         this.tmpStartingServers.delete(id);
    //     }
    // }

    // /**
    //  * Stop the Jupyter server for an environment
    //  */
    // // public async stopServer(id: string, token?: CancellationToken): Promise<void> {
    // public async stopServer(deepnoteFileUri: Uri, token?: CancellationToken): Promise<void> {
    //     // const config = this.environments.get(id);
    //     // if (!config) {
    //     //     throw new Error(`Environment not found: ${id}`);
    //     // }

    //     // if (!config.serverInfo) {
    //     //     logger.info(`No server running for environment: ${config.name} (${id})`);
    //     //     return;
    //     // }

    //     try {
    //         logger.info(`Stopping server for environment: ${deepnoteFileUri.fsPath}`);

    //         await this.serverStarter.stopServer(deepnoteFileUri, token);

    //         // config.serverInfo = undefined;

    //         // await this.persistEnvironments();
    //         // this._onDidChangeEnvironments.fire();

    //         logger.info(`Server stopped successfully for environment: ${deepnoteFileUri.fsPath}`);
    //     } catch (error) {
    //         logger.error(`Failed to stop server for environment: ${deepnoteFileUri.fsPath}`, error);
    //         throw error;
    //     }
    // }

    // /**
    //  * Restart the Jupyter server for an environment
    //  */
    // // public async restartServer(id: string, token?: CancellationToken): Promise<void> {
    // public async restartServer(deepnoteFileUri: Uri, token?: CancellationToken): Promise<void> {
    //     logger.info(`Restarting server for environment: ${deepnoteFileUri.fsPath}`);
    //     await this.stopServer(deepnoteFileUri, token);
    //     Cancellation.throwIfCanceled(token);
    //     await this.startServer(deepnoteFileUri, token);
    //     logger.info(`Server restarted successfully for environment: ${deepnoteFileUri.fsPath}`);
    // }

    /**
     * Update the last used timestamp for an environment
     */
    public async updateLastUsed(id: string): Promise<void> {
        const config = this.environments.get(id);
        if (!config) {
            return;
        }

        config.lastUsedAt = new Date();
        await this.persistEnvironments();
    }

    /**
     * Persist all environments to storage
     */
    private async persistEnvironments(): Promise<void> {
        const configs = Array.from(this.environments.values());
        await this.storage.saveEnvironments(configs);
    }

    /**
     * Dispose of all resources
     */
    public dispose(): void {
        this.outputChannel.dispose();
        this._onDidChangeEnvironments.dispose();
    }
}
