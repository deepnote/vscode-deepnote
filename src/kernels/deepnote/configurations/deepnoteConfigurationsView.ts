// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { commands, Disposable, ProgressLocation, TreeView, window } from 'vscode';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IPythonApiProvider } from '../../../platform/api/types';
import { IDeepnoteConfigurationManager } from '../types';
import { DeepnoteConfigurationTreeDataProvider } from './deepnoteConfigurationTreeDataProvider';
import { DeepnoteConfigurationTreeItem } from './deepnoteConfigurationTreeItem';
import { CreateKernelConfigurationOptions } from './deepnoteKernelConfiguration';
import {
    getCachedEnvironment,
    resolvedPythonEnvToJupyterEnv,
    getPythonEnvironmentName
} from '../../../platform/interpreter/helpers';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';

/**
 * View controller for the Deepnote kernel configurations tree view.
 * Manages the tree view and handles all configuration-related commands.
 */
@injectable()
export class DeepnoteConfigurationsView implements Disposable {
    private readonly treeView: TreeView<DeepnoteConfigurationTreeItem>;
    private readonly treeDataProvider: DeepnoteConfigurationTreeDataProvider;
    private readonly disposables: Disposable[] = [];

    constructor(
        @inject(IDeepnoteConfigurationManager) private readonly configurationManager: IDeepnoteConfigurationManager,
        @inject(IPythonApiProvider) private readonly pythonApiProvider: IPythonApiProvider,
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry
    ) {
        // Create tree data provider
        this.treeDataProvider = new DeepnoteConfigurationTreeDataProvider(configurationManager);

        // Create tree view
        this.treeView = window.createTreeView('deepnoteKernelConfigurations', {
            treeDataProvider: this.treeDataProvider,
            showCollapseAll: true
        });

        this.disposables.push(this.treeView);
        this.disposables.push(this.treeDataProvider);

        // Register commands
        this.registerCommands();

        // Register for disposal
        disposableRegistry.push(this);
    }

    private registerCommands(): void {
        // Refresh command
        this.disposables.push(
            commands.registerCommand('deepnote.configurations.refresh', () => {
                this.treeDataProvider.refresh();
            })
        );

        // Create configuration command
        this.disposables.push(
            commands.registerCommand('deepnote.configurations.create', async () => {
                await this.createConfiguration();
            })
        );

        // Start server command
        this.disposables.push(
            commands.registerCommand('deepnote.configurations.start', async (item: DeepnoteConfigurationTreeItem) => {
                if (item?.configuration) {
                    await this.startServer(item.configuration.id);
                }
            })
        );

        // Stop server command
        this.disposables.push(
            commands.registerCommand('deepnote.configurations.stop', async (item: DeepnoteConfigurationTreeItem) => {
                if (item?.configuration) {
                    await this.stopServer(item.configuration.id);
                }
            })
        );

        // Restart server command
        this.disposables.push(
            commands.registerCommand('deepnote.configurations.restart', async (item: DeepnoteConfigurationTreeItem) => {
                if (item?.configuration) {
                    await this.restartServer(item.configuration.id);
                }
            })
        );

        // Delete configuration command
        this.disposables.push(
            commands.registerCommand('deepnote.configurations.delete', async (item: DeepnoteConfigurationTreeItem) => {
                if (item?.configuration) {
                    await this.deleteConfiguration(item.configuration.id);
                }
            })
        );

        // Edit name command
        this.disposables.push(
            commands.registerCommand(
                'deepnote.configurations.editName',
                async (item: DeepnoteConfigurationTreeItem) => {
                    if (item?.configuration) {
                        await this.editConfigurationName(item.configuration.id);
                    }
                }
            )
        );

        // Manage packages command
        this.disposables.push(
            commands.registerCommand(
                'deepnote.configurations.managePackages',
                async (item: DeepnoteConfigurationTreeItem) => {
                    if (item?.configuration) {
                        await this.managePackages(item.configuration.id);
                    }
                }
            )
        );
    }

    private async createConfiguration(): Promise<void> {
        try {
            // Step 1: Select Python interpreter
            const api = await this.pythonApiProvider.getNewApi();
            if (!api || !api.environments.known || api.environments.known.length === 0) {
                void window.showErrorMessage('No Python interpreters found. Please install Python first.');
                return;
            }

            const interpreterItems = api.environments.known
                .map((env) => {
                    const interpreter = resolvedPythonEnvToJupyterEnv(getCachedEnvironment(env));
                    if (!interpreter) {
                        return undefined;
                    }
                    return {
                        label: getPythonEnvironmentName(interpreter) || getDisplayPath(interpreter.uri),
                        description: getDisplayPath(interpreter.uri),
                        interpreter
                    };
                })
                .filter(
                    (
                        item
                    ): item is {
                        label: string;
                        description: string;
                        interpreter: import('../../../platform/pythonEnvironments/info').PythonEnvironment;
                    } => item !== undefined
                );

            const selectedInterpreter = await window.showQuickPick(interpreterItems, {
                placeHolder: 'Select a Python interpreter for this configuration',
                matchOnDescription: true
            });

            if (!selectedInterpreter) {
                return;
            }

            // Step 2: Enter configuration name
            const name = await window.showInputBox({
                prompt: 'Enter a name for this kernel configuration',
                placeHolder: 'e.g., Python 3.11 (Data Science)',
                validateInput: (value: string) => {
                    if (!value || value.trim().length === 0) {
                        return 'Name cannot be empty';
                    }
                    return undefined;
                }
            });

            if (!name) {
                return;
            }

            // Step 3: Enter packages (optional)
            const packagesInput = await window.showInputBox({
                prompt: 'Enter additional packages to install (comma-separated, optional)',
                placeHolder: 'e.g., pandas, numpy, matplotlib',
                validateInput: (value: string) => {
                    if (!value || value.trim().length === 0) {
                        return undefined; // Empty is OK
                    }
                    // Basic validation: check for valid package names
                    const packages = value.split(',').map((p: string) => p.trim());
                    for (const pkg of packages) {
                        if (!/^[a-zA-Z0-9_\-\[\]]+$/.test(pkg)) {
                            return `Invalid package name: ${pkg}`;
                        }
                    }
                    return undefined;
                }
            });

            // Parse packages
            const packages =
                packagesInput && packagesInput.trim().length > 0
                    ? packagesInput
                          .split(',')
                          .map((p: string) => p.trim())
                          .filter((p: string) => p.length > 0)
                    : undefined;

            // Step 4: Enter description (optional)
            const description = await window.showInputBox({
                prompt: 'Enter a description for this configuration (optional)',
                placeHolder: 'e.g., Environment for data science projects'
            });

            // Create configuration with progress
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Creating kernel configuration "${name}"...`,
                    cancellable: false
                },
                async (progress: { report: (value: { message?: string; increment?: number }) => void }) => {
                    progress.report({ message: 'Setting up virtual environment...' });

                    const options: CreateKernelConfigurationOptions = {
                        name: name.trim(),
                        pythonInterpreter: selectedInterpreter.interpreter,
                        packages,
                        description: description?.trim()
                    };

                    try {
                        const config = await this.configurationManager.createConfiguration(options);
                        logger.info(`Created kernel configuration: ${config.id} (${config.name})`);

                        void window.showInformationMessage(`Kernel configuration "${name}" created successfully!`);
                    } catch (error) {
                        logger.error(`Failed to create kernel configuration: ${error}`);
                        throw error;
                    }
                }
            );
        } catch (error) {
            void window.showErrorMessage(`Failed to create configuration: ${error}`);
        }
    }

    private async startServer(configurationId: string): Promise<void> {
        const config = this.configurationManager.getConfiguration(configurationId);
        if (!config) {
            return;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Starting server for "${config.name}"...`,
                    cancellable: false
                },
                async () => {
                    await this.configurationManager.startServer(configurationId);
                    logger.info(`Started server for configuration: ${configurationId}`);
                }
            );

            void window.showInformationMessage(`Server started for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to start server: ${error}`);
            void window.showErrorMessage(`Failed to start server: ${error}`);
        }
    }

    private async stopServer(configurationId: string): Promise<void> {
        const config = this.configurationManager.getConfiguration(configurationId);
        if (!config) {
            return;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Stopping server for "${config.name}"...`,
                    cancellable: false
                },
                async () => {
                    await this.configurationManager.stopServer(configurationId);
                    logger.info(`Stopped server for configuration: ${configurationId}`);
                }
            );

            void window.showInformationMessage(`Server stopped for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to stop server: ${error}`);
            void window.showErrorMessage(`Failed to stop server: ${error}`);
        }
    }

    private async restartServer(configurationId: string): Promise<void> {
        const config = this.configurationManager.getConfiguration(configurationId);
        if (!config) {
            return;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Restarting server for "${config.name}"...`,
                    cancellable: false
                },
                async () => {
                    await this.configurationManager.restartServer(configurationId);
                    logger.info(`Restarted server for configuration: ${configurationId}`);
                }
            );

            void window.showInformationMessage(`Server restarted for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to restart server: ${error}`);
            void window.showErrorMessage(`Failed to restart server: ${error}`);
        }
    }

    private async deleteConfiguration(configurationId: string): Promise<void> {
        const config = this.configurationManager.getConfiguration(configurationId);
        if (!config) {
            return;
        }

        // Confirm deletion
        const confirmation = await window.showWarningMessage(
            `Are you sure you want to delete "${config.name}"? This will remove the virtual environment and cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirmation !== 'Delete') {
            return;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Deleting configuration "${config.name}"...`,
                    cancellable: false
                },
                async () => {
                    await this.configurationManager.deleteConfiguration(configurationId);
                    logger.info(`Deleted configuration: ${configurationId}`);
                }
            );

            void window.showInformationMessage(`Configuration "${config.name}" deleted`);
        } catch (error) {
            logger.error(`Failed to delete configuration: ${error}`);
            void window.showErrorMessage(`Failed to delete configuration: ${error}`);
        }
    }

    private async editConfigurationName(configurationId: string): Promise<void> {
        const config = this.configurationManager.getConfiguration(configurationId);
        if (!config) {
            return;
        }

        const newName = await window.showInputBox({
            prompt: 'Enter a new name for this configuration',
            value: config.name,
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Name cannot be empty';
                }
                return undefined;
            }
        });

        if (!newName || newName === config.name) {
            return;
        }

        try {
            await this.configurationManager.updateConfiguration(configurationId, {
                name: newName.trim()
            });

            logger.info(`Renamed configuration ${configurationId} to "${newName}"`);
            void window.showInformationMessage(`Configuration renamed to "${newName}"`);
        } catch (error) {
            logger.error(`Failed to rename configuration: ${error}`);
            void window.showErrorMessage(`Failed to rename configuration: ${error}`);
        }
    }

    private async managePackages(configurationId: string): Promise<void> {
        const config = this.configurationManager.getConfiguration(configurationId);
        if (!config) {
            return;
        }

        // Show input box for package names
        const packagesInput = await window.showInputBox({
            prompt: 'Enter packages to install (comma-separated)',
            placeHolder: 'e.g., pandas, numpy, matplotlib',
            value: config.packages?.join(', ') || '',
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return 'Please enter at least one package';
                }
                const packages = value.split(',').map((p: string) => p.trim());
                for (const pkg of packages) {
                    if (!/^[a-zA-Z0-9_\-\[\]]+$/.test(pkg)) {
                        return `Invalid package name: ${pkg}`;
                    }
                }
                return undefined;
            }
        });

        if (!packagesInput) {
            return;
        }

        const packages = packagesInput
            .split(',')
            .map((p: string) => p.trim())
            .filter((p: string) => p.length > 0);

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Updating packages for "${config.name}"...`,
                    cancellable: false
                },
                async () => {
                    await this.configurationManager.updateConfiguration(configurationId, { packages });
                    logger.info(`Updated packages for configuration ${configurationId}`);
                }
            );

            void window.showInformationMessage(`Packages updated for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to update packages: ${error}`);
            void window.showErrorMessage(`Failed to update packages: ${error}`);
        }
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }
}
