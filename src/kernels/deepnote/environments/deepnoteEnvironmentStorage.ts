import { injectable, inject } from 'inversify';
import { Memento, Uri } from 'vscode';
import { IExtensionContext } from '../../../platform/common/types';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { logger } from '../../../platform/logging';
import { DeepnoteEnvironment, DeepnoteEnvironmentState } from './deepnoteEnvironment';

const STORAGE_KEY = 'deepnote.kernelEnvironments';

/**
 * Service for persisting and loading environments from global storage.
 */
@injectable()
export class DeepnoteEnvironmentStorage {
    private readonly globalState: Memento;

    constructor(@inject(IExtensionContext) context: IExtensionContext) {
        this.globalState = context.globalState;
    }

    /**
     * Load all environments from storage
     */
    public async loadEnvironments(): Promise<DeepnoteEnvironment[]> {
        try {
            const states = this.globalState.get<DeepnoteEnvironmentState[]>(STORAGE_KEY, []);
            const environments: DeepnoteEnvironment[] = [];

            for (const state of states) {
                const config = this.deserializeEnvironment(state);
                if (config) {
                    environments.push(config);
                } else {
                    logger.error(`Failed to deserialize environment: ${state.id}`);
                }
            }

            logger.info(`Loaded ${environments.length} environments from storage`);
            return environments;
        } catch (error) {
            logger.error('Failed to load environments', error);
            return [];
        }
    }

    /**
     * Save all environments to storage
     */
    public async saveEnvironments(environments: DeepnoteEnvironment[]): Promise<void> {
        try {
            const states = environments.map((config) => this.serializeEnvironment(config));
            await this.globalState.update(STORAGE_KEY, states);
            logger.info(`Saved ${environments.length} environments to storage`);
        } catch (error) {
            logger.error('Failed to save environments', error);
            throw error;
        }
    }

    /**
     * Serialize an environment to a storable state
     */
    private serializeEnvironment(config: DeepnoteEnvironment): DeepnoteEnvironmentState {
        return {
            id: config.id,
            name: config.name,
            pythonInterpreterPath: config.pythonInterpreter.uri.fsPath,
            venvPath: config.venvPath.fsPath,
            createdAt: config.createdAt.toISOString(),
            lastUsedAt: config.lastUsedAt.toISOString(),
            packages: config.packages,
            toolkitVersion: config.toolkitVersion,
            description: config.description
        };
    }

    /**
     * Deserialize a stored state back to an environment
     */
    private deserializeEnvironment(state: DeepnoteEnvironmentState): DeepnoteEnvironment | undefined {
        try {
            const interpreterUri = Uri.file(state.pythonInterpreterPath);

            // Create PythonEnvironment directly from stored path
            // No need to resolve through interpreter service - we just need the path
            const interpreter: PythonEnvironment = {
                uri: interpreterUri,
                id: interpreterUri.fsPath
            };

            return {
                id: state.id,
                name: state.name,
                pythonInterpreter: interpreter,
                venvPath: Uri.file(state.venvPath),
                createdAt: new Date(state.createdAt),
                lastUsedAt: new Date(state.lastUsedAt),
                packages: state.packages,
                toolkitVersion: state.toolkitVersion,
                description: state.description,
                serverInfo: undefined // Don't persist server info across sessions
            };
        } catch (error) {
            logger.error(`Failed to deserialize environment ${state.id}`, error);
            return undefined;
        }
    }

    /**
     * Clear all environments from storage
     */
    public async clearEnvironments(): Promise<void> {
        try {
            await this.globalState.update(STORAGE_KEY, []);
            logger.info('Cleared all environments from storage');
        } catch (error) {
            logger.error('Failed to clear environments', error);
            throw error;
        }
    }
}
