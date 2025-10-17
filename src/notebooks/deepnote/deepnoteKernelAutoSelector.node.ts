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
    Disposable
} from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import {
    IDeepnoteKernelAutoSelector,
    IDeepnoteServerStarter,
    IDeepnoteToolkitInstaller,
    IDeepnoteServerProvider,
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
import { IKernelProvider, IKernel } from '../../kernels/types';

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
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter,
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
        @inject(IDeepnoteRequirementsHelper) private readonly requirementsHelper: IDeepnoteRequirementsHelper
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

                    // No existing controller, so create a new one
                    logger.info(`Creating new Deepnote kernel for ${getDisplayPath(notebook.uri)}`);
                    progress.report({ message: 'Setting up Deepnote kernel...' });

                    // Check if Python extension is installed
                    if (!this.pythonExtensionChecker.isPythonExtensionInstalled) {
                        logger.warn('Python extension is not installed. Prompting user to install it.');
                        await this.pythonExtensionChecker.showPythonExtensionInstallRequiredPrompt();
                        return; // Exit - user needs to install Python extension first
                    }

                    // Get active Python interpreter
                    progress.report({ message: 'Finding Python interpreter...' });
                    const interpreter = await this.interpreterService.getActiveInterpreter(notebook.uri);
                    if (!interpreter) {
                        logger.warn(
                            'No Python interpreter found for Deepnote notebook. Kernel selection will be manual.'
                        );
                        return; // Exit gracefully - user can select kernel manually
                    }

                    logger.info(`Using base interpreter: ${getDisplayPath(interpreter.uri)}`);

                    // Ensure deepnote-toolkit is installed in a venv and get the venv interpreter
                    progress.report({ message: 'Installing Deepnote toolkit...' });
                    const venvInterpreter = await this.toolkitInstaller.ensureInstalled(
                        interpreter,
                        baseFileUri,
                        progressToken
                    );
                    if (!venvInterpreter) {
                        logger.error('Failed to set up Deepnote toolkit environment');
                        return; // Exit gracefully
                    }

                    logger.info(`Deepnote toolkit venv ready at: ${getDisplayPath(venvInterpreter.uri)}`);

                    // Start the Deepnote server using the venv interpreter
                    progress.report({ message: 'Starting Deepnote server...' });
                    const serverInfo = await this.serverStarter.getOrStartServer(
                        venvInterpreter,
                        baseFileUri,
                        progressToken
                    );
                    logger.info(`Deepnote server running at ${serverInfo.url}`);

                    // Create server provider handle
                    const serverProviderHandle: JupyterServerProviderHandle = {
                        extensionId: JVSC_EXTENSION_ID,
                        id: 'deepnote-server',
                        handle: `deepnote-toolkit-server-${baseFileUri.fsPath}`
                    };

                    // Register the server with the provider so it can be resolved
                    this.serverProvider.registerServer(serverProviderHandle.handle, serverInfo);

                    // Track the server handle for cleanup when notebook is closed
                    this.notebookServerHandles.set(notebookKey, serverProviderHandle.handle);

                    // Connect to the server and get available kernel specs
                    progress.report({ message: 'Connecting to kernel...' });
                    const connectionInfo = createJupyterConnectionInfo(
                        serverProviderHandle,
                        {
                            baseUrl: serverInfo.url,
                            token: serverInfo.token || '',
                            displayName: 'Deepnote Server',
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
                        logger.info(
                            `Available kernel specs on Deepnote server: ${kernelSpecs.map((s) => s.name).join(', ')}`
                        );

                        // Create expected kernel name based on file path (uses installer's hash logic)
                        const venvHash = this.toolkitInstaller.getVenvHash(baseFileUri);
                        const expectedKernelName = `deepnote-venv-${venvHash}`;
                        logger.info(`Looking for venv kernel spec: ${expectedKernelName}`);

                        // Prefer the venv kernel spec that uses the venv's Python interpreter
                        // This ensures packages installed via pip are available to the kernel
                        kernelSpec = kernelSpecs.find((s) => s.name === expectedKernelName);

                        if (!kernelSpec) {
                            logger.warn(
                                `⚠️ Venv kernel spec '${expectedKernelName}' not found! Falling back to generic Python kernel.`
                            );
                            logger.warn(
                                `This may cause import errors if packages are installed to the venv but kernel uses system Python.`
                            );
                            kernelSpec =
                                kernelSpecs.find((s) => s.language === 'python') ||
                                kernelSpecs.find((s) => s.name === 'python3-venv') ||
                                kernelSpecs[0];
                        }

                        if (!kernelSpec) {
                            throw new Error('No kernel specs available on Deepnote server');
                        }

                        logger.info(`✓ Using kernel spec: ${kernelSpec.name} (${kernelSpec.display_name})`);
                    } finally {
                        await disposeAsync(sessionManager);
                    }

                    progress.report({ message: 'Finalizing kernel setup...' });
                    const newConnectionMetadata = DeepnoteKernelConnectionMetadata.create({
                        interpreter,
                        kernelSpec,
                        baseUrl: serverInfo.url,
                        id: `deepnote-kernel-${interpreter.id}`,
                        serverProviderHandle,
                        serverInfo // Pass the server info so we can use it later
                    });

                    // Store connection metadata for reuse
                    this.notebookConnectionMetadata.set(notebookKey, newConnectionMetadata);

                    // Register controller for deepnote notebook type
                    const controllers = this.controllerRegistration.addOrUpdate(newConnectionMetadata, [
                        DEEPNOTE_NOTEBOOK_TYPE
                    ]);

                    if (controllers.length === 0) {
                        logger.error('Failed to create Deepnote kernel controller');
                        throw new Error('Failed to create Deepnote kernel controller');
                    }

                    const controller = controllers[0];
                    logger.info(`Created Deepnote kernel controller: ${controller.id}`);

                    // Store the controller for reuse
                    this.notebookControllers.set(notebookKey, controller);

                    // Prepare init notebook execution for when kernel starts
                    // This MUST complete before marking controller as preferred to avoid race conditions
                    const projectId = notebook.metadata?.deepnoteProjectId;
                    const project = projectId
                        ? (this.notebookManager.getOriginalProject(projectId) as DeepnoteProject | undefined)
                        : undefined;

                    if (project) {
                        // Create requirements.txt first (needs to be ready for init notebook)
                        progress.report({ message: 'Creating requirements.txt...' });
                        await this.requirementsHelper.createRequirementsFile(project, progressToken);
                        logger.info(`Created requirements.txt for project ${projectId}`);

                        // Check if project has an init notebook that hasn't been run yet
                        if (
                            project.project.initNotebookId &&
                            !this.notebookManager.hasInitNotebookBeenRun(projectId!)
                        ) {
                            // Store for execution when kernel actually starts
                            // Kernels are created lazily when cells execute, so we can't run init notebook now
                            this.projectsPendingInitNotebook.set(projectId!, { notebook, project });
                            logger.info(
                                `Init notebook will run automatically when kernel starts for project ${projectId}`
                            );
                        }
                    }

                    // Mark this controller as protected so it won't be automatically disposed
                    // This is similar to how active interpreter controllers are protected
                    this.controllerRegistration.trackActiveInterpreterControllers(controllers);
                    logger.info(`Marked Deepnote controller as protected from automatic disposal`);

                    // Listen to controller disposal so we can clean up our tracking
                    controller.onDidDispose(() => {
                        logger.info(`Deepnote controller ${controller!.id} disposed, removing from tracking`);
                        this.notebookControllers.delete(notebookKey);
                        // Keep connection metadata for quick recreation
                        // The metadata is still valid and can be used to recreate the controller
                    });

                    // Auto-select the controller for this notebook using affinity
                    // Setting NotebookControllerAffinity.Preferred will make VSCode automatically select this controller
                    // This is done AFTER requirements.txt creation to avoid race conditions
                    controller.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

                    logger.info(`Successfully auto-selected Deepnote kernel for ${getDisplayPath(notebook.uri)}`);
                    progress.report({ message: 'Kernel ready!' });

                    // Dispose the loading controller once the real one is ready
                    const loadingController = this.loadingControllers.get(notebookKey);
                    if (loadingController) {
                        loadingController.dispose();
                        this.loadingControllers.delete(notebookKey);
                        logger.info(`Disposed loading controller for ${notebookKey}`);
                    }
                } catch (ex) {
                    logger.error(`Failed to auto-select Deepnote kernel: ${ex}`);
                    throw ex;
                }
            }
        );
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
