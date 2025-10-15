// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { commands, Disposable, ProgressLocation, TreeView, window } from 'vscode';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IPythonApiProvider } from '../../../platform/api/types';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironmentTreeDataProvider } from './deepnoteEnvironmentTreeDataProvider';
import { DeepnoteEnvironmentTreeItem } from './deepnoteEnvironmentTreeItem';
import { CreateEnvironmentOptions } from './deepnoteEnvironment';
import {
    getCachedEnvironment,
    resolvedPythonEnvToJupyterEnv,
    getPythonEnvironmentName
} from '../../../platform/interpreter/helpers';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';

/**
 * View controller for the Deepnote kernel environments tree view.
 * Manages the tree view and handles all environment-related commands.
 */
@injectable()
export class DeepnoteEnvironmentsView implements Disposable {
    private readonly treeView: TreeView<DeepnoteEnvironmentTreeItem>;
    private readonly treeDataProvider: DeepnoteEnvironmentTreeDataProvider;
    private readonly disposables: Disposable[] = [];

    constructor(
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager,
        @inject(IPythonApiProvider) private readonly pythonApiProvider: IPythonApiProvider,
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry
    ) {
        // Create tree data provider
        this.treeDataProvider = new DeepnoteEnvironmentTreeDataProvider(environmentManager);

        // Create tree view
        this.treeView = window.createTreeView('deepnoteKernelEnvironments', {
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
            commands.registerCommand('deepnote.environments.refresh', () => {
                this.treeDataProvider.refresh();
            })
        );

        // Create environment command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.create', async () => {
                await this.createEnvironmentCommand();
            })
        );

        // Start server command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.start', async (item: DeepnoteEnvironmentTreeItem) => {
                if (item?.environment) {
                    await this.startServer(item.environment.id);
                }
            })
        );

        // Stop server command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.stop', async (item: DeepnoteEnvironmentTreeItem) => {
                if (item?.environment) {
                    await this.stopServer(item.environment.id);
                }
            })
        );

        // Restart server command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.restart', async (item: DeepnoteEnvironmentTreeItem) => {
                if (item?.environment) {
                    await this.restartServer(item.environment.id);
                }
            })
        );

        // Delete environment command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.delete', async (item: DeepnoteEnvironmentTreeItem) => {
                if (item?.environment) {
                    await this.deleteEnvironmentCommand(item.environment.id);
                }
            })
        );

        // Edit name command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.editName', async (item: DeepnoteEnvironmentTreeItem) => {
                if (item?.environment) {
                    await this.editEnvironmentName(item.environment.id);
                }
            })
        );

        // Manage packages command
        this.disposables.push(
            commands.registerCommand(
                'deepnote.environments.managePackages',
                async (item: DeepnoteEnvironmentTreeItem) => {
                    if (item?.environment) {
                        await this.managePackages(item.environment.id);
                    }
                }
            )
        );
    }

    private async createEnvironmentCommand(): Promise<void> {
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
                placeHolder: 'Select a Python interpreter for this environment',
                matchOnDescription: true
            });

            if (!selectedInterpreter) {
                return;
            }

            // Step 2: Enter environment name
            const name = await window.showInputBox({
                prompt: 'Enter a name for this environment',
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
                prompt: 'Enter a description for this environment (optional)',
                placeHolder: 'e.g., Environment for data science projects'
            });

            // Create environment with progress
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: `Creating environment "${name}"...`,
                    cancellable: false
                },
                async (progress: { report: (value: { message?: string; increment?: number }) => void }) => {
                    progress.report({ message: 'Setting up virtual environment...' });

                    const options: CreateEnvironmentOptions = {
                        name: name.trim(),
                        pythonInterpreter: selectedInterpreter.interpreter,
                        packages,
                        description: description?.trim()
                    };

                    try {
                        const config = await this.environmentManager.createEnvironment(options);
                        logger.info(`Created environment: ${config.id} (${config.name})`);

                        void window.showInformationMessage(`Environment "${name}" created successfully!`);
                    } catch (error) {
                        logger.error(`Failed to create environment: ${error}`);
                        throw error;
                    }
                }
            );
        } catch (error) {
            void window.showErrorMessage(`Failed to create environment: ${error}`);
        }
    }

    private async startServer(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
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
                    await this.environmentManager.startServer(environmentId);
                    logger.info(`Started server for environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(`Server started for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to start server: ${error}`);
            void window.showErrorMessage(`Failed to start server: ${error}`);
        }
    }

    private async stopServer(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
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
                    await this.environmentManager.stopServer(environmentId);
                    logger.info(`Stopped server for environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(`Server stopped for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to stop server: ${error}`);
            void window.showErrorMessage(`Failed to stop server: ${error}`);
        }
    }

    private async restartServer(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
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
                    await this.environmentManager.restartServer(environmentId);
                    logger.info(`Restarted server for environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(`Server restarted for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to restart server: ${error}`);
            void window.showErrorMessage(`Failed to restart server: ${error}`);
        }
    }

    private async deleteEnvironmentCommand(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
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
                    title: `Deleting environment "${config.name}"...`,
                    cancellable: false
                },
                async () => {
                    await this.environmentManager.deleteEnvironment(environmentId);
                    logger.info(`Deleted environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(`Environment "${config.name}" deleted`);
        } catch (error) {
            logger.error(`Failed to delete environment: ${error}`);
            void window.showErrorMessage(`Failed to delete environment: ${error}`);
        }
    }

    private async editEnvironmentName(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
        if (!config) {
            return;
        }

        const newName = await window.showInputBox({
            prompt: 'Enter a new name for this environment',
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
            await this.environmentManager.updateEnvironment(environmentId, {
                name: newName.trim()
            });

            logger.info(`Renamed environment ${environmentId} to "${newName}"`);
            void window.showInformationMessage(`Environment renamed to "${newName}"`);
        } catch (error) {
            logger.error(`Failed to rename environment: ${error}`);
            void window.showErrorMessage(`Failed to rename environment: ${error}`);
        }
    }

    private async managePackages(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
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
                    await this.environmentManager.updateEnvironment(environmentId, { packages });
                    logger.info(`Updated packages for environment ${environmentId}`);
                }
            );

            void window.showInformationMessage(`Packages updated for "${config.name}"`);
        } catch (error) {
            logger.error(`Failed to update packages: ${error}`);
            void window.showErrorMessage(`Failed to update packages: ${error}`);
        }
    }

    public dispose(): void {
        this.disposables.forEach((d) => d?.dispose());
    }
}
