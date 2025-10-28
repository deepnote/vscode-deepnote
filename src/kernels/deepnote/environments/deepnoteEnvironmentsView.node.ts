import { inject, injectable } from 'inversify';
import { commands, Disposable, l10n, ProgressLocation, QuickPickItem, TreeView, window } from 'vscode';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IPythonApiProvider } from '../../../platform/api/types';
import { IDeepnoteEnvironmentManager, IDeepnoteKernelAutoSelector, IDeepnoteNotebookEnvironmentMapper } from '../types';
import { DeepnoteEnvironmentTreeDataProvider } from './deepnoteEnvironmentTreeDataProvider.node';
import { DeepnoteEnvironmentTreeItem } from './deepnoteEnvironmentTreeItem.node';
import { CreateDeepnoteEnvironmentOptions, EnvironmentStatus } from './deepnoteEnvironment';
import {
    getCachedEnvironment,
    resolvedPythonEnvToJupyterEnv,
    getPythonEnvironmentName
} from '../../../platform/interpreter/helpers';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';
import { IKernelProvider } from '../../types';
import { getDeepnoteEnvironmentStatusVisual } from './deepnoteEnvironmentUi';

/**
 * View controller for the Deepnote kernel environments tree view.
 * Manages the tree view and handles all environment-related commands.
 */
@injectable()
export class DeepnoteEnvironmentsView implements Disposable {
    private readonly treeView: TreeView<DeepnoteEnvironmentTreeItem>;
    private readonly disposables: Disposable[] = [];

    constructor(
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager,
        @inject(DeepnoteEnvironmentTreeDataProvider)
        private readonly treeDataProvider: DeepnoteEnvironmentTreeDataProvider,
        @inject(IPythonApiProvider) private readonly pythonApiProvider: IPythonApiProvider,
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
        @inject(IDeepnoteKernelAutoSelector) private readonly kernelAutoSelector: IDeepnoteKernelAutoSelector,
        @inject(IDeepnoteNotebookEnvironmentMapper)
        private readonly notebookEnvironmentMapper: IDeepnoteNotebookEnvironmentMapper,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider
    ) {
        // Create tree data provider

        // Create tree view
        this.treeView = window.createTreeView('deepnoteEnvironments', {
            treeDataProvider: this.treeDataProvider,
            showCollapseAll: true
        });

        this.disposables.push(this.treeView);

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

        // Switch environment for notebook command
        this.disposables.push(
            commands.registerCommand('deepnote.environments.selectForNotebook', async () => {
                await this.selectEnvironmentForNotebook();
            })
        );
    }

    private async createEnvironmentCommand(): Promise<void> {
        try {
            // Step 1: Select Python interpreter
            const api = await this.pythonApiProvider.getNewApi();
            if (!api || !api.environments.known || api.environments.known.length === 0) {
                void window.showErrorMessage(l10n.t('No Python interpreters found. Please install Python first.'));
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
                placeHolder: l10n.t('Select a Python interpreter for this environment'),
                matchOnDescription: true
            });

            if (!selectedInterpreter) {
                return;
            }

            // Step 2: Enter environment name
            const name = await window.showInputBox({
                prompt: l10n.t('Enter a name for this environment'),
                placeHolder: l10n.t('e.g., Python 3.11 (Data Science)'),
                validateInput: (value: string) => {
                    if (!value || value.trim().length === 0) {
                        return l10n.t('Name cannot be empty');
                    }
                    return undefined;
                }
            });

            if (!name) {
                return;
            }

            // Check if name is already in use
            const existingEnvironments = this.environmentManager.listEnvironments();
            if (existingEnvironments.some((env) => env.name === name)) {
                void window.showErrorMessage(l10n.t('An environment with this name already exists'));
                return;
            }

            // Step 3: Enter packages (optional)
            const packagesInput = await window.showInputBox({
                prompt: l10n.t('Enter additional packages to install (comma-separated, optional)'),
                placeHolder: l10n.t('e.g., pandas, numpy, matplotlib'),
                validateInput: (value: string) => {
                    if (!value || value.trim().length === 0) {
                        return undefined; // Empty is OK
                    }
                    // Basic validation: check for valid package names
                    const packages = value.split(',').map((p: string) => p.trim());
                    for (const pkg of packages) {
                        const isValid =
                            /^[A-Za-z0-9._\-]+(\[[A-Za-z0-9_,.\-]+\])?(\s*(==|>=|<=|~=|>|<)\s*[A-Za-z0-9.*+!\-_.]+)?(?:\s*;.+)?$/.test(
                                pkg
                            );
                        if (!isValid) {
                            return l10n.t('Invalid package name: {0}', pkg);
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
                prompt: l10n.t('Enter a description for this environment (optional)'),
                placeHolder: l10n.t('e.g., Environment for data science projects')
            });

            // Create environment with progress
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Creating environment "{0}"...', name),
                    cancellable: true
                },
                async (progress: { report: (value: { message?: string; increment?: number }) => void }, token) => {
                    progress.report({ message: l10n.t('Setting up virtual environment...') });

                    const options: CreateDeepnoteEnvironmentOptions = {
                        name: name.trim(),
                        pythonInterpreter: selectedInterpreter.interpreter,
                        packages,
                        description: description?.trim()
                    };

                    try {
                        const config = await this.environmentManager.createEnvironment(options, token);
                        logger.info(`Created environment: ${config.id} (${config.name})`);

                        void window.showInformationMessage(
                            l10n.t('Environment "{0}" created successfully!', config.name)
                        );
                    } catch (error) {
                        logger.error('Failed to create environment', error);
                        throw error;
                    }
                }
            );
        } catch (error) {
            void window.showErrorMessage(l10n.t('Failed to create environment. See output for details.'));
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
                    title: l10n.t('Starting server for "{0}"...', config.name),
                    cancellable: true
                },
                async (_progress, token) => {
                    await this.environmentManager.startServer(environmentId, token);
                    logger.info(`Started server for environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(l10n.t('Server started for "{0}"', config.name));
        } catch (error) {
            logger.error('Failed to start server', error);
            void window.showErrorMessage(l10n.t('Failed to start server. See output for details.'));
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
                    title: l10n.t('Stopping server for "{0}"...', config.name),
                    cancellable: true
                },
                async (_progress, token) => {
                    await this.environmentManager.stopServer(environmentId, token);
                    logger.info(`Stopped server for environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(l10n.t('Server stopped for "{0}"', config.name));
        } catch (error) {
            logger.error('Failed to stop server', error);
            void window.showErrorMessage(l10n.t('Failed to stop server. See output for details.'));
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
                    title: l10n.t('Restarting server for "{0}"...', config.name),
                    cancellable: true
                },
                async (_progress, token) => {
                    await this.environmentManager.restartServer(environmentId, token);
                    logger.info(`Restarted server for environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(l10n.t('Server restarted for "{0}"', config.name));
        } catch (error) {
            logger.error('Failed to restart server', error);
            void window.showErrorMessage(l10n.t('Failed to restart server. See output for details.'));
        }
    }

    private async deleteEnvironmentCommand(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
        if (!config) {
            return;
        }

        // Confirm deletion
        const confirmation = await window.showWarningMessage(
            l10n.t(
                'Are you sure you want to delete "{0}"? This will remove the virtual environment and cannot be undone.',
                config.name
            ),
            { modal: true },
            l10n.t('Delete')
        );

        if (confirmation !== l10n.t('Delete')) {
            return;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Deleting environment "{0}"...', config.name),
                    cancellable: true
                },
                async (_progress, token) => {
                    // Clean up notebook mappings referencing this env
                    const notebooks = this.notebookEnvironmentMapper.getNotebooksUsingEnvironment(environmentId);
                    for (const nb of notebooks) {
                        await this.notebookEnvironmentMapper.removeEnvironmentForNotebook(nb);
                    }

                    await this.environmentManager.deleteEnvironment(environmentId, token);
                    logger.info(`Deleted environment: ${environmentId}`);
                }
            );

            void window.showInformationMessage(l10n.t('Environment "{0}" deleted', config.name));
        } catch (error) {
            logger.error('Failed to delete environment', error);
            void window.showErrorMessage(l10n.t('Failed to delete environment. See output for details.'));
        }
    }

    public async editEnvironmentName(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
        if (!config) {
            return;
        }

        const newName = await window.showInputBox({
            prompt: l10n.t('Enter a new name for this environment'),
            value: config.name,
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Name cannot be empty');
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
            void window.showInformationMessage(l10n.t('Environment renamed to "{0}"', newName));
        } catch (error) {
            logger.error('Failed to rename environment', error);
            void window.showErrorMessage(l10n.t('Failed to rename environment. See output for details.'));
        }
    }

    private async managePackages(environmentId: string): Promise<void> {
        const config = this.environmentManager.getEnvironment(environmentId);
        if (!config) {
            return;
        }

        // Show input box for package names
        const packagesInput = await window.showInputBox({
            prompt: l10n.t('Enter packages to install (comma-separated)'),
            placeHolder: l10n.t('e.g., pandas, numpy, matplotlib'),
            value: config.packages?.join(', ') || '',
            validateInput: (value: string) => {
                if (!value || value.trim().length === 0) {
                    return l10n.t('Please enter at least one package');
                }
                const packages = value.split(',').map((p: string) => p.trim());
                for (const pkg of packages) {
                    const isValid =
                        /^[A-Za-z0-9._\-]+(\[[A-Za-z0-9_,.\-]+\])?(\s*(==|>=|<=|~=|>|<)\s*[A-Za-z0-9.*+!\-_.]+)?(?:\s*;.+)?$/.test(
                            pkg
                        );
                    if (!isValid) {
                        return l10n.t('Invalid package name: {0}', pkg);
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
                    title: l10n.t('Updating packages for "{0}"...', config.name),
                    cancellable: false
                },
                async () => {
                    await this.environmentManager.updateEnvironment(environmentId, { packages });
                    logger.info(`Updated packages for environment ${environmentId}`);
                }
            );

            void window.showInformationMessage(l10n.t('Packages updated for "{0}"', config.name));
        } catch (error) {
            logger.error('Failed to update packages', error);
            void window.showErrorMessage(l10n.t('Failed to update packages. See output for details.'));
        }
    }

    private async selectEnvironmentForNotebook(): Promise<void> {
        // Get the active notebook
        const activeNotebook = window.activeNotebookEditor?.notebook;
        if (!activeNotebook || activeNotebook.notebookType !== 'deepnote') {
            void window.showWarningMessage(l10n.t('No active Deepnote notebook found'));
            return;
        }

        // Get base file URI (without query/fragment)
        const baseFileUri = activeNotebook.uri.with({ query: '', fragment: '' });

        // Get current environment selection
        const currentEnvironmentId = this.notebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri);
        const currentEnvironment = currentEnvironmentId
            ? this.environmentManager.getEnvironment(currentEnvironmentId)
            : undefined;

        // Get all environments
        const environments = this.environmentManager.listEnvironments();

        if (environments.length === 0) {
            const choice = await window.showInformationMessage(
                l10n.t('No environments found. Create one first?'),
                l10n.t('Create Environment'),
                l10n.t('Cancel')
            );

            if (choice === l10n.t('Create Environment')) {
                await commands.executeCommand('deepnote.environments.create');
            }
            return;
        }

        // Build quick pick items
        const items: (QuickPickItem & { environmentId?: string })[] = environments.map((env) => {
            const envWithStatus = this.environmentManager.getEnvironmentWithStatus(env.id);

            const { icon, text } = getDeepnoteEnvironmentStatusVisual(
                envWithStatus?.status ?? EnvironmentStatus.Stopped
            );

            const isCurrent = currentEnvironment?.id === env.id;

            return {
                label: `${icon} ${env.name} [${text}]${isCurrent ? ' $(check)' : ''}`,
                description: getDisplayPath(env.pythonInterpreter.uri),
                detail: env.packages?.length
                    ? l10n.t('Packages: {0}', env.packages.join(', '))
                    : l10n.t('No additional packages'),
                environmentId: env.id
            };
        });

        // Add "Create new" option at the end
        items.push({
            label: l10n.t('$(add) Create New Environment'),
            description: l10n.t('Set up a new kernel environment'),
            alwaysShow: true
        });

        const selected = await window.showQuickPick(items, {
            placeHolder: l10n.t('Select an environment for this notebook'),
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            return; // User cancelled
        }

        if (!selected.environmentId) {
            // User chose "Create new"
            await commands.executeCommand('deepnote.environments.create');
            return;
        }

        // Check if user selected the same environment
        if (selected.environmentId === currentEnvironmentId) {
            logger.info(`User selected the same environment - no changes needed`);
            return;
        }

        // Check if any cells are currently executing using the kernel execution state
        // This is more reliable than checking executionSummary
        const kernel = this.kernelProvider.get(activeNotebook);
        const hasExecutingCells = kernel
            ? this.kernelProvider.getKernelExecution(kernel).pendingCells.length > 0
            : false;

        if (hasExecutingCells) {
            const proceed = await window.showWarningMessage(
                l10n.t(
                    'Some cells are currently executing. Switching environments now may cause errors. Do you want to continue?'
                ),
                { modal: true },
                l10n.t('Yes, Switch Anyway'),
                l10n.t('Cancel')
            );

            if (proceed !== l10n.t('Yes, Switch Anyway')) {
                logger.info('User cancelled environment switch due to executing cells');
                return;
            }
        }

        // User selected a different environment - switch to it
        logger.info(
            `Switching notebook ${getDisplayPath(activeNotebook.uri)} to environment ${selected.environmentId}`
        );

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Switching to environment...'),
                    cancellable: false
                },
                async () => {
                    // Update the notebook-to-environment mapping
                    await this.notebookEnvironmentMapper.setEnvironmentForNotebook(
                        baseFileUri,
                        selected.environmentId!
                    );

                    // Force rebuild the controller with the new environment
                    // This clears cached metadata and creates a fresh controller.
                    await this.kernelAutoSelector.rebuildController(activeNotebook);

                    logger.info(`Successfully switched to environment ${selected.environmentId}`);
                }
            );

            void window.showInformationMessage(l10n.t('Environment switched successfully'));
        } catch (error) {
            logger.error('Failed to switch environment', error);
            void window.showErrorMessage(l10n.t('Failed to switch environment. See output for details.'));
        }
    }

    public dispose(): void {
        this.disposables.forEach((d) => d?.dispose());
    }
}
