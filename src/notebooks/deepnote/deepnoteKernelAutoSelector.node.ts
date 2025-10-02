// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, optional } from 'inversify';
import { CancellationToken, NotebookDocument, workspace, NotebookControllerAffinity } from 'vscode';
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
        @inject(IConfigurationService) private readonly configService: IConfigurationService
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

        // Always try to ensure kernel is selected (this will reuse existing controllers)
        try {
            await this.ensureKernelSelected(notebook);
        } catch (error) {
            logger.error(`Failed to auto-select Deepnote kernel for ${getDisplayPath(notebook.uri)}: ${error}`);
            // Don't rethrow - we want activation to continue even if one notebook fails
        }
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
    }

    public async ensureKernelSelected(notebook: NotebookDocument, token?: CancellationToken): Promise<void> {
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
                    `Reusing existing Deepnote controller ${existingController.id} for ${getDisplayPath(notebook.uri)}`
                );

                // Ensure server is registered with the provider (it might have been unregistered on close)
                if (connectionMetadata.serverInfo) {
                    const serverProviderHandle = connectionMetadata.serverProviderHandle;
                    this.serverProvider.registerServer(serverProviderHandle.handle, connectionMetadata.serverInfo);
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
                existingController.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);
                logger.info(`Reselected existing Deepnote kernel for ${getDisplayPath(notebook.uri)}`);
                return;
            }

            // No existing controller, so create a new one
            logger.info(`Creating new Deepnote kernel for ${getDisplayPath(notebook.uri)}`);

            // Check if Python extension is installed
            if (!this.pythonExtensionChecker.isPythonExtensionInstalled) {
                logger.warn('Python extension is not installed. Prompting user to install it.');
                await this.pythonExtensionChecker.showPythonExtensionInstallRequiredPrompt();
                return; // Exit - user needs to install Python extension first
            }

            // Get active Python interpreter
            const interpreter = await this.interpreterService.getActiveInterpreter(notebook.uri);
            if (!interpreter) {
                logger.warn('No Python interpreter found for Deepnote notebook. Kernel selection will be manual.');
                return; // Exit gracefully - user can select kernel manually
            }

            logger.info(`Using base interpreter: ${getDisplayPath(interpreter.uri)}`);

            // Ensure deepnote-toolkit is installed in a venv and get the venv interpreter
            const venvInterpreter = await this.toolkitInstaller.ensureInstalled(interpreter, baseFileUri, token);
            if (!venvInterpreter) {
                logger.error('Failed to set up Deepnote toolkit environment');
                return; // Exit gracefully
            }

            logger.info(`Deepnote toolkit venv ready at: ${getDisplayPath(venvInterpreter.uri)}`);

            // Start the Deepnote server using the venv interpreter
            const serverInfo = await this.serverStarter.getOrStartServer(venvInterpreter, baseFileUri, token);
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
                logger.info(`Available kernel specs on Deepnote server: ${kernelSpecs.map((s) => s.name).join(', ')}`);

                // Use the first available Python kernel spec, or fall back to 'python3-venv'
                kernelSpec =
                    kernelSpecs.find((s) => s.language === 'python') ||
                    kernelSpecs.find((s) => s.name === 'python3-venv') ||
                    kernelSpecs[0];

                if (!kernelSpec) {
                    throw new Error('No kernel specs available on Deepnote server');
                }

                logger.info(`Using kernel spec: ${kernelSpec.name} (${kernelSpec.display_name})`);
            } finally {
                await disposeAsync(sessionManager);
            }

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
            controller.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

            logger.info(`Successfully auto-selected Deepnote kernel for ${getDisplayPath(notebook.uri)}`);
        } catch (ex) {
            logger.error(`Failed to auto-select Deepnote kernel: ${ex}`);
            throw ex;
        }
    }
}
