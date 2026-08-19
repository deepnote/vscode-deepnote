import { inject, injectable, named } from 'inversify';
import * as path from '../../../platform/vscode-path/path';
import { CancellationToken, EventEmitter, l10n, Uri } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { Cancellation } from '../../../platform/common/cancellation';
import { STANDARD_OUTPUT_CHANNEL } from '../../../platform/common/constants';
import { IFileSystem } from '../../../platform/common/platform/types';
import { IProcessServiceFactory } from '../../../platform/common/process/types.node';
import { IExtensionContext, IOutputChannel } from '../../../platform/common/types';
import { generateUuid as uuid } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import { IDeepnoteEnvironmentManager } from '../types';
import { CreateDeepnoteEnvironmentOptions, DeepnoteEnvironment } from './deepnoteEnvironment';
import { DeepnoteEnvironmentStorage } from './deepnoteEnvironmentStorage.node';

/**
 * Manager for Deepnote kernel environments.
 * Handles CRUD operations and server lifecycle management.
 */
@injectable()
export class DeepnoteEnvironmentManager implements IExtensionSyncActivationService, IDeepnoteEnvironmentManager {
    private environments: Map<string, DeepnoteEnvironment> = new Map();
    private readonly _onDidChangeEnvironments = new EventEmitter<void>();
    public readonly onDidChangeEnvironments = this._onDidChangeEnvironments.event;
    private initializationPromise: Promise<void> | undefined;

    constructor(
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(DeepnoteEnvironmentStorage) private readonly storage: DeepnoteEnvironmentStorage,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IFileSystem) private readonly fileSystem: IFileSystem,
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory
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

            let needsMigration = false;

            for (const config of configs) {
                const venvDirName = path.basename(config.venvPath.fsPath);

                // Check if venv path is under current globalStorage
                const expectedVenvParent = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs').fsPath;
                const actualVenvParent = path.dirname(config.venvPath.fsPath);
                logger.info(`Actual venv parent: ${actualVenvParent}`);
                logger.info(`Expected venv parent: ${expectedVenvParent}`);
                const isInCorrectStorage = actualVenvParent === expectedVenvParent;
                logger.info(`Is in correct storage: ${isInCorrectStorage}`);
                logger.info(`Managed venv: ${config.managedVenv}`);

                // Check if directory name matches the environment ID and is in correct storage
                const isExpectedPath = venvDirName === config.id && isInCorrectStorage;
                const needsPathMigration = !isExpectedPath && config.managedVenv === true;

                if (needsPathMigration) {
                    logger.info(
                        `Migrating environment "${config.name}" from ${config.venvPath.fsPath} to ID-based path`
                    );

                    config.venvPath = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', config.id);
                    config.toolkitVersion = undefined;

                    logger.info(`New venv path: ${config.venvPath.fsPath} (will be recreated on next use)`);
                    needsMigration = true;
                }

                this.environments.set(config.id, config);
            }

            if (needsMigration) {
                logger.info('Saving migrated environments to storage');
                await this.persistEnvironments();
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

        // Check if the Python interpreter is already in a virtual environment
        const existingVenvPath = await this.getVenvPathIfInVenv(options.pythonInterpreter.uri);
        logger.info(`Existing venv path: ${existingVenvPath?.fsPath}`);
        const venvPath = existingVenvPath ?? Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', id);
        logger.info(`Venv path: ${venvPath.fsPath}`);

        const environment: DeepnoteEnvironment = {
            id,
            name: options.name,
            pythonInterpreter: options.pythonInterpreter,
            managedVenv: existingVenvPath == null,
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

        Cancellation.throwIfCanceled(token);

        // Only delete the virtual environment directory if it was created by us (managed venv)
        // This prevents accidental deletion of user's original virtual environments
        if (config.managedVenv) {
            try {
                await this.fileSystem.delete(config.venvPath);
                logger.info(`Deleted virtual environment directory: ${config.venvPath.fsPath}`);
            } catch (error) {
                // Log but don't fail - the directory might not exist or might already be deleted
                logger.warn(`Failed to delete virtual environment directory: ${config.venvPath.fsPath}`, error);
                const msg = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(
                    l10n.t('Failed to delete Deepnote virtual environment directory for "{0}": {1}', config.name, msg)
                );
            }
        } else {
            logger.info(`Skipping deletion of external virtual environment: ${config.venvPath.fsPath}`);
        }

        Cancellation.throwIfCanceled(token);

        this.environments.delete(id);
        await this.persistEnvironments();
        this._onDidChangeEnvironments.fire();

        logger.info(`Deleted environment: ${config.name} (${id})`);
    }

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
        this._onDidChangeEnvironments.fire();
    }

    /**
     * Check if a Python binary is inside a virtual environment by executing it.
     * Returns the venv root path if it is, otherwise returns undefined.
     *
     * Detection is based on comparing sys.prefix vs sys.base_prefix:
     * - In a virtual environment, sys.prefix points to the venv directory
     * - sys.base_prefix points to the original Python installation
     * - If they differ, Python is running inside a venv
     */
    private async getVenvPathIfInVenv(pythonUri: Uri): Promise<Uri | undefined> {
        try {
            const processService = await this.processServiceFactory.create(undefined);

            // Execute Python to check if sys.prefix differs from sys.base_prefix
            // If they differ, we're in a virtual environment
            // Output format: "is_venv|prefix_path" where is_venv is 1 or 0
            const result = await processService.exec(
                pythonUri.fsPath,
                ['-c', 'import sys; print("1" if sys.prefix != sys.base_prefix else "0", sys.prefix, sep="|")'],
                { timeout: 5000 }
            );

            const output = result.stdout.trim();
            const [isVenv, prefixPath] = output.split('|');

            if (isVenv === '1' && prefixPath) {
                logger.info(`Detected existing virtual environment at: ${prefixPath}`);
                return Uri.file(prefixPath);
            }

            return undefined;
        } catch (ex) {
            logger.warn('Failed to check if Python is in a virtual environment', ex);
            return undefined;
        }
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
        this._onDidChangeEnvironments.dispose();
    }
}
