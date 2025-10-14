import { injectable, inject } from 'inversify';
import { Memento, Uri } from 'vscode';
import { IExtensionContext } from '../../../platform/common/types';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import { logger } from '../../../platform/logging';
import { DeepnoteKernelConfiguration, DeepnoteKernelConfigurationState } from './deepnoteKernelConfiguration';

const STORAGE_KEY = 'deepnote.kernelConfigurations';

/**
 * Service for persisting and loading kernel configurations from global storage.
 */
@injectable()
export class DeepnoteConfigurationStorage {
    private readonly globalState: Memento;

    constructor(
        @inject(IExtensionContext) context: IExtensionContext,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService
    ) {
        this.globalState = context.globalState;
    }

    /**
     * Load all configurations from storage
     */
    public async loadConfigurations(): Promise<DeepnoteKernelConfiguration[]> {
        try {
            const states = this.globalState.get<DeepnoteKernelConfigurationState[]>(STORAGE_KEY, []);
            const configurations: DeepnoteKernelConfiguration[] = [];

            for (const state of states) {
                const config = await this.deserializeConfiguration(state);
                if (config) {
                    configurations.push(config);
                } else {
                    logger.error(`Failed to deserialize configuration: ${state.id}`);
                }
            }

            logger.info(`Loaded ${configurations.length} kernel configurations from storage`);
            return configurations;
        } catch (error) {
            logger.error('Failed to load kernel configurations', error);
            return [];
        }
    }

    /**
     * Save all configurations to storage
     */
    public async saveConfigurations(configurations: DeepnoteKernelConfiguration[]): Promise<void> {
        try {
            const states = configurations.map((config) => this.serializeConfiguration(config));
            await this.globalState.update(STORAGE_KEY, states);
            logger.info(`Saved ${configurations.length} kernel configurations to storage`);
        } catch (error) {
            logger.error('Failed to save kernel configurations', error);
            throw error;
        }
    }

    /**
     * Serialize a configuration to a storable state
     */
    private serializeConfiguration(config: DeepnoteKernelConfiguration): DeepnoteKernelConfigurationState {
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
     * Deserialize a stored state back to a configuration
     */
    private async deserializeConfiguration(
        state: DeepnoteKernelConfigurationState
    ): Promise<DeepnoteKernelConfiguration | undefined> {
        try {
            // Try to resolve the Python interpreter
            const interpreterUri = Uri.file(state.pythonInterpreterPath);
            const interpreter = await this.resolveInterpreter(interpreterUri);

            if (!interpreter) {
                logger.error(
                    `Failed to resolve Python interpreter at ${state.pythonInterpreterPath} for configuration ${state.id}`
                );
                return undefined;
            }

            return {
                id: state.id,
                name: state.name,
                pythonInterpreter: interpreter,
                venvPath: Uri.file(state.venvPath),
                createdAt: new Date(state.createdAt),
                lastUsedAt: new Date(state.lastUsedAt),
                packages: state.packages,
                toolkitVersion: state.toolkitVersion,
                description: state.description
            };
        } catch (error) {
            logger.error(`Failed to deserialize configuration ${state.id}`, error);
            return undefined;
        }
    }

    /**
     * Resolve a Python interpreter from a URI
     */
    private async resolveInterpreter(interpreterUri: Uri): Promise<PythonEnvironment | undefined> {
        try {
            const interpreterDetails = await this.interpreterService.getInterpreterDetails(interpreterUri);
            return interpreterDetails;
        } catch (error) {
            logger.error(`Failed to get interpreter details for ${interpreterUri.fsPath}`, error);
            return undefined;
        }
    }

    /**
     * Clear all configurations from storage
     */
    public async clearConfigurations(): Promise<void> {
        try {
            await this.globalState.update(STORAGE_KEY, []);
            logger.info('Cleared all kernel configurations from storage');
        } catch (error) {
            logger.error('Failed to clear kernel configurations', error);
            throw error;
        }
    }
}
