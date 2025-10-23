// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, optional } from 'inversify';
import {
    CancellationToken,
    NotebookDocument,
    workspace,
    NotebookControllerAffinity,
    window,
    ProgressLocation,
    notebooks,
    NotebookController,
    CancellationTokenSource,
    Disposable,
    Uri
} from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import {
    IDeepnoteKernelAutoSelector,
    IDeepnoteServerProvider,
    IDeepnoteEnvironmentManager,
    IDeepnoteEnvironmentPicker,
    IDeepnoteNotebookEnvironmentMapper,
    DEEPNOTE_NOTEBOOK_TYPE,
    DeepnoteKernelConnectionMetadata
} from '../../kernels/deepnote/types';
import { IControllerRegistration, IVSCodeNotebookController } from '../controllers/types';
import { JVSC_EXTENSION_ID } from '../../platform/common/constants';
import { getDisplayPath } from '../../platform/common/platform/fs-paths';
import { JupyterServerProviderHandle } from '../../kernels/jupyter/types';
import { IPythonExtensionChecker } from '../../platform/api/types';
import { JupyterLabHelper } from '../../kernels/jupyter/session/jupyterLabHelper';
import { createJupyterConnectionInfo } from '../../kernels/jupyter/jupyterUtils';
import { IJupyterRequestCreator, IJupyterRequestAgentCreator } from '../../kernels/jupyter/types';
import { IConfigurationService } from '../../platform/common/types';
import { disposeAsync } from '../../platform/common/utils';
import { IDeepnoteInitNotebookRunner } from './deepnoteInitNotebookRunner.node';
import { IDeepnoteNotebookManager } from '../types';
import { IDeepnoteRequirementsHelper } from './deepnoteRequirementsHelper.node';
import { DeepnoteProject } from './deepnoteTypes';
import { IKernelProvider, IKernel, IJupyterKernelSpec } from '../../kernels/types';
import { DeepnoteEnvironment } from '../../kernels/deepnote/environments/deepnoteEnvironment';

/**
 * Automatically selects and starts Deepnote kernel for .deepnote notebooks
 */
@injectable()
export class DeepnoteKernelAutoSelector implements IDeepnoteKernelAutoSelector, IExtensionSyncActivationService {
    // Track server handles per notebook URI for cleanup
    private readonly notebookServerHandles = new Map<string, string>();
    // Track registered controllers per notebook file (base URI) for reuse
    private readonly notebookControllers = new Map<string, IVSCodeNotebookController>();
    // Track connection metadata per notebook file for reuse
    private readonly notebookConnectionMetadata = new Map<string, DeepnoteKernelConnectionMetadata>();
    // Track temporary loading controllers that get disposed when real controller is ready
    private readonly loadingControllers = new Map<string, NotebookController>();
    // Track projects where we need to run init notebook (set during controller setup)
    private readonly projectsPendingInitNotebook = new Map<
        string,
        { notebook: NotebookDocument; project: DeepnoteProject }
    >();

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IControllerRegistration) private readonly controllerRegistration: IControllerRegistration,
        @inject(IPythonExtensionChecker) private readonly pythonExtensionChecker: IPythonExtensionChecker,
        @inject(IDeepnoteServerProvider) private readonly serverProvider: IDeepnoteServerProvider,
        @inject(IJupyterRequestCreator) private readonly requestCreator: IJupyterRequestCreator,
        @inject(IJupyterRequestAgentCreator)
        @optional()
        private readonly requestAgentCreator: IJupyterRequestAgentCreator | undefined,
        @inject(IConfigurationService) private readonly configService: IConfigurationService,
        @inject(IDeepnoteInitNotebookRunner) private readonly initNotebookRunner: IDeepnoteInitNotebookRunner,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IDeepnoteRequirementsHelper) private readonly requirementsHelper: IDeepnoteRequirementsHelper,
        @inject(IDeepnoteEnvironmentManager) private readonly configurationManager: IDeepnoteEnvironmentManager,
        @inject(IDeepnoteEnvironmentPicker) private readonly configurationPicker: IDeepnoteEnvironmentPicker,
        @inject(IDeepnoteNotebookEnvironmentMapper)
        private readonly notebookEnvironmentMapper: IDeepnoteNotebookEnvironmentMapper
    ) {}

    public activate() {
        // Listen to notebook open events
        workspace.onDidOpenNotebookDocument(this.onDidOpenNotebook, this, this.disposables);

        // Listen to notebook close events for cleanup
        workspace.onDidCloseNotebookDocument(this.onDidCloseNotebook, this, this.disposables);

        // Listen to controller selection changes to detect when kernel becomes unselected
        // (This is now mostly a safety net since controllers are protected from disposal)
        this.controllerRegistration.onControllerSelectionChanged(
            this.onControllerSelectionChanged,
            this,
            this.disposables
        );

        // Listen to kernel starts to run init notebooks
        // Kernels are created lazily when cells are executed, so this is the right time to run init notebook
        this.kernelProvider.onDidStartKernel(this.onKernelStarted, this, this.disposables);

        // Handle currently open notebooks - await all async operations
        Promise.all(workspace.notebookDocuments.map((d) => this.onDidOpenNotebook(d))).catch((error) => {
            logger.error(`Error handling open notebooks during activation: ${error}`);
        });
    }

    private async onDidOpenNotebook(notebook: NotebookDocument) {
        // Only handle deepnote notebooks
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        logger.info(`Deepnote notebook opened: ${getDisplayPath(notebook.uri)}`);

        // Check if we already have a controller ready for this notebook
        const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
        const notebookKey = baseFileUri.fsPath;
        const hasExistingController = this.notebookControllers.has(notebookKey);

        // If no existing controller, create a temporary "Loading" controller immediately
        // This prevents the kernel selector from appearing when user clicks Run All
        if (!hasExistingController) {
            this.createLoadingController(notebook, notebookKey);
        }

        // Always try to ensure kernel is selected (this will reuse existing controllers)
        // Don't await - let it happen in background so notebook opens quickly
        void this.ensureKernelSelected(notebook).catch((error) => {
            logger.error(`Failed to auto-select Deepnote kernel for ${getDisplayPath(notebook.uri)}: ${error}`);
            void window.showErrorMessage(`Failed to load Deepnote kernel: ${error}`);
        });
    }

    private onControllerSelectionChanged(event: {
        notebook: NotebookDocument;
        controller: IVSCodeNotebookController;
        selected: boolean;
    }) {
        // Only handle deepnote notebooks
        if (event.notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const baseFileUri = event.notebook.uri.with({ query: '', fragment: '' });
        const notebookKey = baseFileUri.fsPath;

        // If the Deepnote controller for this notebook was deselected, try to reselect it
        // Since controllers are now protected from disposal, this should rarely happen
        if (!event.selected) {
            const ourController = this.notebookControllers.get(notebookKey);
            if (ourController && ourController.id === event.controller.id) {
                logger.warn(
                    `Deepnote controller was unexpectedly deselected for ${getDisplayPath(
                        event.notebook.uri
                    )}. Reselecting...`
                );
                // Reselect the controller
                ourController.controller.updateNotebookAffinity(event.notebook, NotebookControllerAffinity.Preferred);
            }
        }
    }

    private onDidCloseNotebook(notebook: NotebookDocument) {
        // Only handle deepnote notebooks
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        logger.info(`Deepnote notebook closed: ${getDisplayPath(notebook.uri)}`);

        // Extract the base file URI to match what we used when registering
        const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
        const notebookKey = baseFileUri.fsPath;

        // Note: We intentionally don't clean up controllers, connection metadata, or servers here.
        // This allows the kernel to be reused if the user reopens the same .deepnote file.
        // The server will continue running and can be reused for better performance.
        // Cleanup will happen when the extension is disposed or when explicitly requested.

        // However, we do unregister the server from the provider to keep it clean
        const serverHandle = this.notebookServerHandles.get(notebookKey);
        if (serverHandle) {
            logger.info(`Unregistering server for closed notebook: ${serverHandle}`);
            this.serverProvider.unregisterServer(serverHandle);
            this.notebookServerHandles.delete(notebookKey);
        }

        // Clean up pending init notebook tracking
        const projectId = notebook.metadata?.deepnoteProjectId;
        if (projectId) {
            this.projectsPendingInitNotebook.delete(projectId);
        }
    }

    private async onKernelStarted(kernel: IKernel) {
        // Only handle deepnote notebooks
        if (kernel.notebook?.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const notebook = kernel.notebook;
        const projectId = notebook.metadata?.deepnoteProjectId;

        if (!projectId) {
            return;
        }

        // Check if we have a pending init notebook for this project
        const pendingInit = this.projectsPendingInitNotebook.get(projectId);
        if (!pendingInit) {
            return; // No init notebook to run
        }

        logger.info(`Kernel started for Deepnote notebook, running init notebook for project ${projectId}`);

        // Remove from pending list
        this.projectsPendingInitNotebook.delete(projectId);

        // Create a CancellationTokenSource tied to the notebook lifecycle
        const cts = new CancellationTokenSource();
        const disposables: Disposable[] = [];

        try {
            // Register handler to cancel the token if the notebook is closed
            // Note: We check the URI to ensure we only cancel for the specific notebook that closed
            const closeListener = workspace.onDidCloseNotebookDocument((closedNotebook) => {
                if (closedNotebook.uri.toString() === notebook.uri.toString()) {
                    logger.info(`Notebook closed while init notebook was running, cancelling for project ${projectId}`);
                    cts.cancel();
                }
            });
            disposables.push(closeListener);

            // Run init notebook with cancellation support
            await this.initNotebookRunner.runInitNotebookIfNeeded(projectId, notebook, cts.token);
        } catch (error) {
            // Check if this is a cancellation error - if so, just log and continue
            if (error instanceof Error && error.message === 'Cancelled') {
                logger.info(`Init notebook cancelled for project ${projectId}`);
                return;
            }
            logger.error(`Error running init notebook: ${error}`);
            // Continue anyway - don't block user if init fails
        } finally {
            // Always clean up the CTS and event listeners
            cts.dispose();
            disposables.forEach((d) => d.dispose());
        }
    }

    /**
     * Switch controller to use a different environment by updating the existing controller's connection.
     * Because we use notebook-based controller IDs (not environment-based), the controller ID stays the same
     * and addOrUpdate will call updateConnection() on the existing controller instead of creating a new one.
     * This keeps VS Code bound to the same controller object, avoiding DISPOSED errors.
     */
    public async rebuildController(notebook: NotebookDocument, token?: CancellationToken): Promise<void> {
        const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
        const notebookKey = baseFileUri.fsPath;

        logger.info(`Switching controller environment for ${getDisplayPath(notebook.uri)}`);

        // Check if any cells are executing and log a warning
        const kernel = this.kernelProvider.get(notebook);
        if (kernel) {
            const pendingCells = this.kernelProvider.getKernelExecution(kernel).pendingCells;
            if (pendingCells.length > 0) {
                logger.warn(
                    `Switching environments while ${pendingCells.length} cell(s) are executing. Cells may fail.`
                );
            }
        }

        // Clear cached metadata so ensureKernelSelected creates fresh metadata with new environment
        // The controller will stay alive - it will just get updated via updateConnection()
        this.notebookConnectionMetadata.delete(notebookKey);

        // Clear old server handle - new environment will register a new handle
        const oldServerHandle = this.notebookServerHandles.get(notebookKey);
        if (oldServerHandle) {
            logger.info(`Clearing old server handle from tracking: ${oldServerHandle}`);
            this.notebookServerHandles.delete(notebookKey);
        }

        // Update the controller with new environment's metadata
        // Because we use notebook-based controller IDs, addOrUpdate will call updateConnection()
        // on the existing controller instead of creating a new one
        await this.ensureKernelSelected(notebook, token);

        logger.info(`Controller successfully switched to new environment`);
    }

    public async ensureKernelSelected(notebook: NotebookDocument, _token?: CancellationToken): Promise<void> {
        return window.withProgress(
            {
                location: ProgressLocation.Notification,
                title: 'Loading Deepnote Kernel',
                cancellable: true
            },
            async (progress, progressToken) => {
                try {
                    logger.info(`Ensuring Deepnote kernel is selected for ${getDisplayPath(notebook.uri)}`);

                    // Extract the base file URI (without query parameters)
                    // Notebooks from the same .deepnote file have different URIs with ?notebook=id query params
                    const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
                    const notebookKey = baseFileUri.fsPath;
                    logger.info(`Base Deepnote file: ${getDisplayPath(baseFileUri)}`);

                    // Check if we already have a controller for this notebook file
                    let existingController = this.notebookControllers.get(notebookKey);
                    const connectionMetadata = this.notebookConnectionMetadata.get(notebookKey);

                    // If we have an existing controller, reuse it (controllers are now protected from disposal)
                    if (existingController && connectionMetadata) {
                        logger.info(
                            `Reusing existing Deepnote controller ${existingController.id} for ${getDisplayPath(
                                notebook.uri
                            )}`
                        );
                        progress.report({ message: 'Reusing existing kernel...' });

                        // Ensure server is registered with the provider (it might have been unregistered on close)
                        if (connectionMetadata.serverInfo) {
                            const serverProviderHandle = connectionMetadata.serverProviderHandle;
                            this.serverProvider.registerServer(
                                serverProviderHandle.handle,
                                connectionMetadata.serverInfo
                            );
                            this.notebookServerHandles.set(notebookKey, serverProviderHandle.handle);
                            logger.info(`Re-registered server for reuse: ${serverProviderHandle.handle}`);
                        }

                        // Check if this controller is already selected for this notebook
                        const selectedController = this.controllerRegistration.getSelected(notebook);
                        if (selectedController && selectedController.id === existingController.id) {
                            logger.info(`Controller already selected for ${getDisplayPath(notebook.uri)}`);
                            return;
                        }

                        // Auto-select the existing controller for this notebook
                        existingController.controller.updateNotebookAffinity(
                            notebook,
                            NotebookControllerAffinity.Preferred
                        );
                        logger.info(`Reselected existing Deepnote kernel for ${getDisplayPath(notebook.uri)}`);

                        // Dispose the loading controller if it exists
                        const loadingController = this.loadingControllers.get(notebookKey);
                        if (loadingController) {
                            loadingController.dispose();
                            this.loadingControllers.delete(notebookKey);
                            logger.info(`Disposed loading controller for ${notebookKey}`);
                        }

                        return;
                    }

                    // No existing controller - check if user has selected a configuration for this notebook
                    logger.info(`Checking for configuration selection for ${getDisplayPath(baseFileUri)}`);
                    let selectedConfigId = this.notebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri);
                    let selectedConfig = selectedConfigId
                        ? this.configurationManager.getEnvironment(selectedConfigId)
                        : undefined;

                    // If no configuration selected, or selected config was deleted, show picker
                    if (!selectedConfig) {
                        if (selectedConfigId) {
                            logger.warn(
                                `Previously selected configuration ${selectedConfigId} not found - showing picker`
                            );
                        } else {
                            logger.info(`No configuration selected for notebook - showing picker`);
                        }

                        progress.report({ message: 'Select kernel configuration...' });
                        selectedConfig = await this.configurationPicker.pickEnvironment(baseFileUri);

                        if (!selectedConfig) {
                            logger.info(`User cancelled configuration selection - no kernel will be loaded`);
                            throw new Error(
                                'No environment selected. Please create an environment using the Deepnote Environments view.'
                            );
                        }

                        // Save the selection
                        await this.notebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, selectedConfig.id);
                        logger.info(`Saved configuration selection: ${selectedConfig.name} (${selectedConfig.id})`);
                    } else {
                        logger.info(`Using mapped configuration: ${selectedConfig.name} (${selectedConfig.id})`);
                    }

                    // Use the selected configuration
                    return this.ensureKernelSelectedWithConfiguration(
                        notebook,
                        selectedConfig,
                        baseFileUri,
                        notebookKey,
                        progress,
                        progressToken
                    );
                } catch (ex) {
                    logger.error(`Failed to auto-select Deepnote kernel: ${ex}`);
                    throw ex;
                }
            }
        );
    }

    private async ensureKernelSelectedWithConfiguration(
        notebook: NotebookDocument,
        // configuration: import('./../../kernels/deepnote/environments/deepnoteEnvironment').DeepnoteEnvironment,
        configuration: DeepnoteEnvironment,
        baseFileUri: Uri,
        notebookKey: string,
        progress: { report(value: { message?: string; increment?: number }): void },
        progressToken: CancellationToken
    ): Promise<void> {
        logger.info(`Setting up kernel using configuration: ${configuration.name} (${configuration.id})`);
        progress.report({ message: `Using ${configuration.name}...` });

        // Check if Python extension is installed
        if (!this.pythonExtensionChecker.isPythonExtensionInstalled) {
            logger.warn('Python extension is not installed. Prompting user to install it.');
            await this.pythonExtensionChecker.showPythonExtensionInstallRequiredPrompt();
            return;
        }

        // Ensure server is running (startServer is idempotent - returns early if already running)
        // Note: startServer() will create the venv if it doesn't exist
        // IMPORTANT: Always call this and refresh configuration to get current server info,
        // as the configuration object may have stale serverInfo from a previous session
        logger.info(`Ensuring server is running for configuration ${configuration.id}`);
        progress.report({ message: 'Starting Deepnote server...' });
        await this.configurationManager.startServer(configuration.id);

        // ALWAYS refresh configuration to get current serverInfo
        // This is critical because the configuration object may have been cached
        const updatedConfig = this.configurationManager.getEnvironment(configuration.id);
        if (!updatedConfig?.serverInfo) {
            throw new Error('Failed to start server for configuration');
        }
        configuration = updatedConfig; // Use fresh configuration with current serverInfo
        // TypeScript can't infer that serverInfo is non-null after the check above, so we use non-null assertion
        const serverInfo = configuration.serverInfo!;
        logger.info(`Server running at ${serverInfo.url}`);

        // Update last used timestamp
        await this.configurationManager.updateLastUsed(configuration.id);

        // Create server provider handle
        const serverProviderHandle: JupyterServerProviderHandle = {
            extensionId: JVSC_EXTENSION_ID,
            id: 'deepnote-server',
            handle: `deepnote-config-server-${configuration.id}`
        };

        // Register the server with the provider
        this.serverProvider.registerServer(serverProviderHandle.handle, serverInfo);
        this.notebookServerHandles.set(notebookKey, serverProviderHandle.handle);

        // Connect to the server and get available kernel specs
        progress.report({ message: 'Connecting to kernel...' });
        const connectionInfo = createJupyterConnectionInfo(
            serverProviderHandle,
            {
                baseUrl: serverInfo.url,
                token: serverInfo.token || '',
                displayName: `Deepnote: ${configuration.name}`,
                authorizationHeader: {}
            },
            this.requestCreator,
            this.requestAgentCreator,
            this.configService,
            baseFileUri
        );

        const sessionManager = JupyterLabHelper.create(connectionInfo.settings);
        let kernelSpec;
        try {
            const kernelSpecs = await sessionManager.getKernelSpecs();
            logger.info(`Available kernel specs on Deepnote server: ${kernelSpecs.map((s) => s.name).join(', ')}`);

            // Use the extracted kernel selection logic
            kernelSpec = this.selectKernelSpec(kernelSpecs, configuration.id);

            logger.info(`✓ Using kernel spec: ${kernelSpec.name} (${kernelSpec.display_name})`);
        } finally {
            await disposeAsync(sessionManager);
        }

        progress.report({ message: 'Finalizing kernel setup...' });

        // Get the venv Python interpreter (not the base interpreter)
        const venvInterpreter =
            process.platform === 'win32'
                ? Uri.joinPath(configuration.venvPath, 'Scripts', 'python.exe')
                : Uri.joinPath(configuration.venvPath, 'bin', 'python');

        // CRITICAL: Use notebook-based ID instead of environment-based ID
        // This ensures that when switching environments, addOrUpdate will call updateConnection()
        // on the existing controller instead of creating a new one. This keeps VS Code bound to
        // the same controller object, avoiding the DISPOSED error.
        const controllerId = `deepnote-notebook-${notebookKey}`;

        const newConnectionMetadata = DeepnoteKernelConnectionMetadata.create({
            interpreter: { uri: venvInterpreter, id: venvInterpreter.fsPath },
            kernelSpec,
            baseUrl: serverInfo.url,
            id: controllerId,
            serverProviderHandle,
            serverInfo,
            environmentName: configuration.name
        });

        // Store connection metadata for reuse
        this.notebookConnectionMetadata.set(notebookKey, newConnectionMetadata);

        // Register controller for deepnote notebook type
        const controllers = this.controllerRegistration.addOrUpdate(newConnectionMetadata, [DEEPNOTE_NOTEBOOK_TYPE]);

        if (controllers.length === 0) {
            logger.error('Failed to create Deepnote kernel controller');
            throw new Error('Failed to create Deepnote kernel controller');
        }

        const controller = controllers[0];
        logger.info(`Created Deepnote kernel controller: ${controller.id}`);

        // Store the controller for reuse
        this.notebookControllers.set(notebookKey, controller);

        // Prepare init notebook execution
        const projectId = notebook.metadata?.deepnoteProjectId;
        const project = projectId
            ? (this.notebookManager.getOriginalProject(projectId) as DeepnoteProject | undefined)
            : undefined;

        if (project) {
            progress.report({ message: 'Creating requirements.txt...' });
            await this.requirementsHelper.createRequirementsFile(project, progressToken);
            logger.info(`Created requirements.txt for project ${projectId}`);

            if (project.project.initNotebookId && !this.notebookManager.hasInitNotebookBeenRun(projectId!)) {
                this.projectsPendingInitNotebook.set(projectId!, { notebook, project });
                logger.info(`Init notebook will run automatically when kernel starts for project ${projectId}`);
            }
        }

        // Mark controller as protected
        this.controllerRegistration.trackActiveInterpreterControllers(controllers);
        logger.info(`Marked Deepnote controller as protected from automatic disposal`);

        // Listen to controller disposal
        controller.onDidDispose(() => {
            logger.info(`Deepnote controller ${controller!.id} disposed, checking if we should remove from tracking`);
            // Only remove from map if THIS controller is still the one mapped to this notebookKey
            // This prevents old controllers from deleting newer controllers during environment switching
            const currentController = this.notebookControllers.get(notebookKey);
            if (currentController?.id === controller.id) {
                logger.info(`Removing controller ${controller.id} from tracking map`);
                this.notebookControllers.delete(notebookKey);
            } else {
                logger.info(
                    `Not removing controller ${controller.id} from tracking - a newer controller ${currentController?.id} has replaced it`
                );
            }
        });

        // Dispose the loading controller BEFORE selecting the real one
        // This ensures VS Code switches directly to our controller
        const loadingController = this.loadingControllers.get(notebookKey);
        if (loadingController) {
            loadingController.dispose();
            this.loadingControllers.delete(notebookKey);
            logger.info(`Disposed loading controller for ${notebookKey}`);
        }

        // Auto-select the controller
        controller.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

        logger.info(`Successfully set up kernel with configuration: ${configuration.name}`);
        progress.report({ message: 'Kernel ready!' });
    }

    /**
     * Select the appropriate kernel spec for an environment.
     * Extracted for testability.
     * @param kernelSpecs Available kernel specs from the server
     * @param environmentId The environment ID to find a kernel for
     * @returns The selected kernel spec
     * @throws Error if no suitable kernel spec is found
     */
    public selectKernelSpec(kernelSpecs: IJupyterKernelSpec[], environmentId: string): IJupyterKernelSpec {
        // Look for environment-specific kernel first
        const expectedKernelName = `deepnote-${environmentId}`;
        logger.info(`Looking for environment-specific kernel: ${expectedKernelName}`);

        const kernelSpec = kernelSpecs.find((s) => s.name === expectedKernelName);

        if (!kernelSpec) {
            logger.warn(
                `Environment-specific kernel '${expectedKernelName}' not found! Falling back to generic Python kernel.`
            );
            // Fallback to any Python kernel
            const fallbackKernel =
                kernelSpecs.find((s) => s.language === 'python') ||
                kernelSpecs.find((s) => s.name === 'python3') ||
                kernelSpecs[0];

            if (!fallbackKernel) {
                throw new Error('No kernel specs available on Deepnote server');
            }

            return fallbackKernel;
        }

        return kernelSpec;
    }

    private createLoadingController(notebook: NotebookDocument, notebookKey: string): void {
        // Create a temporary controller that shows "Loading..." and prevents kernel selection prompt
        const loadingController = notebooks.createNotebookController(
            `deepnote-loading-${notebookKey}`,
            DEEPNOTE_NOTEBOOK_TYPE,
            'Loading Deepnote Kernel...'
        );

        // Set it as the preferred controller immediately
        loadingController.supportsExecutionOrder = false;
        loadingController.supportedLanguages = ['python'];

        // Execution handler that does nothing - cells will just sit there until real kernel is ready
        loadingController.executeHandler = () => {
            // No-op: execution is blocked until the real controller takes over
        };

        // Select this controller for the notebook
        loadingController.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

        // Store it so we can dispose it later
        this.loadingControllers.set(notebookKey, loadingController);
        logger.info(`Created loading controller for ${notebookKey}`);
    }
}
