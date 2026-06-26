// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DeepnoteFile } from '@deepnote/blocks';
import * as fs from 'fs';
import { inject, injectable, named, optional } from 'inversify';
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    NotebookController,
    NotebookControllerAffinity,
    NotebookDocument,
    NotebookEditor,
    ProgressLocation,
    QuickPickItem,
    Uri,
    commands,
    env,
    l10n,
    notebooks,
    window,
    workspace
} from 'vscode';
import { DeepnoteEnvironment } from '../../kernels/deepnote/environments/deepnoteEnvironment';
import {
    DEEPNOTE_NOTEBOOK_TYPE,
    DEEPNOTE_TOOLKIT_VERSION,
    DeepnoteKernelConnectionMetadata,
    IDeepnoteEnvironmentManager,
    IDeepnoteKernelAutoSelector,
    IDeepnoteLspClientManager,
    IDeepnoteNotebookEnvironmentMapper,
    IDeepnoteServerProvider,
    IDeepnoteServerStarter,
    IDeepnoteToolkitInstaller
} from '../../kernels/deepnote/types';
import { createJupyterConnectionInfo } from '../../kernels/jupyter/jupyterUtils';
import { JupyterLabHelper } from '../../kernels/jupyter/session/jupyterLabHelper';
import {
    IJupyterRequestAgentCreator,
    IJupyterRequestCreator,
    JupyterServerProviderHandle
} from '../../kernels/jupyter/types';
import { IJupyterKernelSpec, IKernel, IKernelProvider } from '../../kernels/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IPythonExtensionChecker } from '../../platform/api/types';
import { Cancellation, isCancellationError } from '../../platform/common/cancellation';
import { JVSC_EXTENSION_ID, STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { getDisplayPath } from '../../platform/common/platform/fs-paths.node';
import { IConfigurationService, IDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { disposeAsync } from '../../platform/common/utils';
import { createDeepnoteServerConfigHandle } from '../../platform/deepnote/deepnoteServerUtils.node';
import { DeepnoteKernelError, DeepnoteToolkitMissingError } from '../../platform/errors/deepnoteKernelErrors';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IControllerRegistration, IVSCodeNotebookController } from '../controllers/types';
import { IDeepnoteNotebookManager } from '../types';
import { IDeepnoteInitNotebookRunner } from './deepnoteInitNotebookRunner.node';
import { computeRequirementsHash } from './deepnoteProjectUtils';
import { IDeepnoteRequirementsHelper } from './deepnoteRequirementsHelper.node';

// Constants for NotebookEditor retry logic
const NOTEBOOK_EDITOR_RETRY_COUNT = 10;
const NOTEBOOK_EDITOR_RETRY_DELAY_MS = 100;

/**
 * Automatically selects and starts Deepnote kernel for .deepnote notebooks
 */
@injectable()
export class DeepnoteKernelAutoSelector implements IDeepnoteKernelAutoSelector, IExtensionSyncActivationService {
    // Track connection metadata per NOTEBOOK for reuse
    private readonly notebookConnectionMetadata = new Map<string, DeepnoteKernelConnectionMetadata>();
    // Track registered controllers per NOTEBOOK (full URI with query) - one controller per notebook
    private readonly notebookControllers = new Map<string, IVSCodeNotebookController>();
    // Track environment for each notebook
    private readonly notebookEnvironmentsIds = new Map<string, string>();
    // Track per-notebook placeholder controllers for notebooks without configured environments
    private readonly placeholderControllers = new Map<string, NotebookController>();
    // Track server handles per PROJECT (baseFileUri) - one server per project
    private readonly projectServerHandles = new Map<string, string>();
    // Track projects where we need to run init notebook (set during controller setup)
    private readonly projectsPendingInitNotebook = new Map<
        string,
        { notebook: NotebookDocument; project: DeepnoteFile }
    >();

    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IControllerRegistration) private readonly controllerRegistration: IControllerRegistration,
        @inject(IPythonExtensionChecker) private readonly pythonExtensionChecker: IPythonExtensionChecker,
        @inject(IDeepnoteServerProvider) private readonly serverProvider: IDeepnoteServerProvider,
        @inject(IDeepnoteLspClientManager) private readonly lspClientManager: IDeepnoteLspClientManager,
        @inject(IJupyterRequestCreator) private readonly requestCreator: IJupyterRequestCreator,
        @inject(IJupyterRequestAgentCreator)
        @optional()
        private readonly requestAgentCreator: IJupyterRequestAgentCreator | undefined,
        @inject(IConfigurationService) private readonly configService: IConfigurationService,
        @inject(IDeepnoteInitNotebookRunner) private readonly initNotebookRunner: IDeepnoteInitNotebookRunner,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IDeepnoteRequirementsHelper) private readonly requirementsHelper: IDeepnoteRequirementsHelper,
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter,
        @inject(IDeepnoteNotebookEnvironmentMapper)
        private readonly notebookEnvironmentMapper: IDeepnoteNotebookEnvironmentMapper,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller
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
        logger.info(`Notebook opened: ${notebook.uri}, with type: ${notebook.notebookType}`);

        // Only handle deepnote notebooks
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        logger.info(`Deepnote notebook opened: ${getDisplayPath(notebook.uri)}`);

        // Always try to ensure kernel is selected (this will reuse existing controllers)
        // Don't await - let it happen in background so notebook opens quickly
        window
            .withProgress<boolean>(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Auto-selecting Deepnote kernel... {0}', getDisplayPath(notebook.uri)),
                    cancellable: true
                },
                async (progress, token) => {
                    try {
                        const result = await this.ensureKernelSelected(notebook, progress, token);
                        return result;
                    } catch (error) {
                        logger.error(
                            `Failed to auto-select Deepnote kernel for ${getDisplayPath(notebook.uri)}`,
                            error
                        );
                        void this.handleKernelSelectionError(error, notebook);
                        return true;
                    }
                }
            )
            .then(
                (result) => {
                    logger.info(`Auto-selecting Deepnote kernel for ${getDisplayPath(notebook.uri)} result: ${result}`);
                    if (!result) {
                        logger.info(`No environment configured for ${getDisplayPath(notebook.uri)}, showing warning`);
                        this.showNoEnvironmentWarning(notebook).catch((error) => {
                            logger.error(
                                `Error showing no environment warning for ${getDisplayPath(notebook.uri)}`,
                                error
                            );
                            void this.handleKernelSelectionError(error, notebook);
                        });
                    }
                },
                (error) => {
                    logger.error(`Error auto-selecting Deepnote kernel for ${getDisplayPath(notebook.uri)}`, error);
                    void this.handleKernelSelectionError(error, notebook);
                }
            );
    }

    private async showNoEnvironmentWarning(notebook: NotebookDocument): Promise<void> {
        logger.info(`Showing no environment warning for ${getDisplayPath(notebook.uri)}`);
        const selectEnvironmentAction = l10n.t('Select Environment');
        const cancelAction = l10n.t('Cancel');

        const selectedAction = await window.showWarningMessage(
            l10n.t('No environment configured for this notebook. Please select an environment to continue.'),
            { modal: false },
            selectEnvironmentAction,
            cancelAction
        );

        logger.info(`Selected action: ${selectedAction}`);
        if (selectedAction === selectEnvironmentAction) {
            logger.info(`Executing command to pick environment for ${getDisplayPath(notebook.uri)}`);
            void commands.executeCommand('deepnote.environments.selectForNotebook', { notebook });
        }
    }

    public async pickEnvironment(notebookUri: Uri): Promise<DeepnoteEnvironment | undefined> {
        logger.info(`Picking environment for notebook ${getDisplayPath(notebookUri)}`);

        // Wait for environment manager to finish loading environments from storage
        await this.environmentManager.waitForInitialization();

        const environments = this.environmentManager.listEnvironments();
        const items: (QuickPickItem & { environment?: DeepnoteEnvironment })[] = environments.map((env) => {
            return {
                label: env.name,
                description: getDisplayPath(env.pythonInterpreter.uri),
                detail: env.packages?.length
                    ? l10n.t('Packages: {0}', env.packages.join(', '))
                    : l10n.t('No additional packages'),
                environment: env
            };
        });

        items.push({
            label: '$(add) Create New Environment',
            description: 'Set up a new kernel environment',
            alwaysShow: true
        });

        const selected = await window.showQuickPick(items, {
            placeHolder: `Select an environment for ${getDisplayPath(notebookUri)}`,
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            logger.info('User cancelled environment selection');
            return; // User cancelled
        }

        if (!selected.environment) {
            logger.info('User chose to create new environment - triggering create command');

            await commands.executeCommand('deepnote.environments.create');

            const newEnvironments = this.environmentManager.listEnvironments();

            if (newEnvironments.length > environments.length) {
                logger.info('Environment created, showing picker again');

                return this.pickEnvironment(notebookUri);
            }

            logger.info('No new environment created');

            return;
        }

        logger.info(`Selected environment "${selected.environment.name}" for notebook ${getDisplayPath(notebookUri)}`);

        return selected.environment;
    }

    private onControllerSelectionChanged(event: {
        notebook: NotebookDocument;
        controller: IVSCodeNotebookController;
        selected: boolean;
    }) {
        logger.info(
            `Controller selection changed for notebook: ${getDisplayPath(event.notebook.uri)}, selected: ${
                event.selected
            }`
        );

        // Only handle deepnote notebooks
        if (event.notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        // const baseFileUri = event.notebook.uri.with({ query: '', fragment: '' });
        // const notebookKey = baseFileUri.fsPath;

        // // If the Deepnote controller for this notebook was deselected, try to reselect it
        // // Since controllers are now protected from disposal, this should rarely happen
        // if (!event.selected) {
        //     const ourController = this.notebookControllers.get(notebookKey);
        //     if (ourController && ourController.id === event.controller.id) {
        //         logger.warn(
        //             `Deepnote controller was unexpectedly deselected for ${getDisplayPath(
        //                 event.notebook.uri
        //             )}. Reselecting...`
        //         );
        //         // Reselect the controller
        //         ourController.controller.updateNotebookAffinity(event.notebook, NotebookControllerAffinity.Preferred);
        //     }
        // }
    }

    private onDidCloseNotebook(notebook: NotebookDocument) {
        logger.info(`Notebook closed: ${getDisplayPath(notebook.uri)}, with type: ${notebook.notebookType}`);

        // Only handle deepnote notebooks
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        logger.info(`Deepnote notebook closed: ${getDisplayPath(notebook.uri)}`);

        // Clean up placeholder controller if it exists
        const notebookKey = notebook.uri.toString();
        const placeholder = this.placeholderControllers.get(notebookKey);

        if (placeholder) {
            logger.info(`Disposing placeholder controller for closed notebook: ${getDisplayPath(notebook.uri)}`);
            placeholder.dispose();
            this.placeholderControllers.delete(notebookKey);
        }
    }

    public async onKernelStarted(kernel: IKernel) {
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

            logger.error('Error running init notebook', error);
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
    public async rebuildController(
        notebook: NotebookDocument,
        progress: { report(value: { message?: string; increment?: number }): void },
        token: CancellationToken
    ): Promise<void> {
        const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
        const notebookKey = notebook.uri.toString();
        const projectKey = baseFileUri.fsPath;

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
        const oldServerHandle = this.projectServerHandles.get(projectKey);
        if (oldServerHandle) {
            logger.info(`Clearing old server handle from tracking: ${oldServerHandle}`);
            this.projectServerHandles.delete(projectKey);
        }

        // Stop existing LSP clients so new ones can be created with fresh environment
        // Without this, the SQL LSP client's command handlers remain registered and
        // cause "command already exists" errors when trying to start new clients
        await this.lspClientManager.stopLspClients(notebook.uri, token);

        // Update the controller with new environment's metadata
        // Because we use notebook-based controller IDs, addOrUpdate will call updateConnection()
        // on the existing controller instead of creating a new one
        const environmentId = this.notebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri);
        const environment = environmentId ? this.environmentManager.getEnvironment(environmentId) : undefined;

        if (environment == null) {
            await this.notebookEnvironmentMapper.removeEnvironmentForNotebook(baseFileUri);
            logger.error(`No environment found for notebook ${getDisplayPath(notebook.uri)}`);
            return;
        }

        await this.ensureKernelSelectedWithConfiguration(
            notebook,
            environment,
            baseFileUri,
            notebookKey,
            projectKey,
            progress,
            token
        );

        logger.info(`Controller successfully switched to new environment`);
    }

    public async ensureKernelSelected(
        notebook: NotebookDocument,
        progress: { report(value: { message?: string; increment?: number }): void },
        token: CancellationToken
    ): Promise<boolean> {
        // baseFileUri identifies the PROJECT (without query/fragment)
        const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
        // notebookKey uniquely identifies THIS NOTEBOOK (includes query with notebook ID)
        const notebookKey = notebook.uri.toString();
        // projectKey identifies the PROJECT for server tracking
        const projectKey = baseFileUri.fsPath;

        const environmentId = this.notebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri);

        if (environmentId == null) {
            await this.selectPlaceholderController(notebook);

            return false;
        }

        const environment = environmentId ? this.environmentManager.getEnvironment(environmentId) : undefined;

        if (environment == null) {
            logger.info(`No environment found for notebook ${getDisplayPath(notebook.uri)}`);
            await this.notebookEnvironmentMapper.removeEnvironmentForNotebook(baseFileUri);
            await this.selectPlaceholderController(notebook);

            return false;
        }

        await this.ensureKernelSelectedWithConfiguration(
            notebook,
            environment,
            baseFileUri,
            notebookKey,
            projectKey,
            progress,
            token
        );

        return true;
    }

    public async ensureKernelSelectedWithConfiguration(
        notebook: NotebookDocument,
        configuration: DeepnoteEnvironment,
        baseFileUri: Uri,
        notebookKey: string,
        projectKey: string,
        progress: { report(value: { message?: string; increment?: number }): void },
        progressToken: CancellationToken
    ): Promise<void> {
        // Dispose placeholder controller if it exists (real controller is taking over)
        const placeholder = this.placeholderControllers.get(notebookKey);

        if (placeholder) {
            logger.info(`Disposing placeholder controller for ${getDisplayPath(notebook.uri)}`);
            placeholder.dispose();
            this.placeholderControllers.delete(notebookKey);
        }

        logger.info(`Setting up kernel using configuration: ${configuration.name} (${configuration.id})`);
        progress.report({ message: `Using ${configuration.name}...` });

        // Check if Python extension is installed
        if (!this.pythonExtensionChecker.isPythonExtensionInstalled) {
            logger.warn('Python extension is not installed. Prompting user to install it.');
            await this.pythonExtensionChecker.showPythonExtensionInstallRequiredPrompt();
            return;
        }

        const existingController = this.notebookControllers.get(notebookKey);
        const existingEnvironmentId = this.notebookEnvironmentsIds.get(notebookKey);

        if (existingEnvironmentId != null && existingController != null && existingEnvironmentId === configuration.id) {
            logger.info(`Existing controller found for notebook ${getDisplayPath(notebook.uri)}, verifying connection`);

            // Verify the controller's interpreter path matches the expected venv path
            // This handles cases where notebooks were used in VS Code and now opened in Cursor
            if (this.isControllerInterpreterValid(existingController, configuration.venvPath)) {
                logger.info(`Controller verified, selecting it`);
                await this.ensureControllerSelectedForNotebook(notebook, existingController, progressToken);

                return;
            }

            const expectedInterpreter = this.getVenvInterpreterUri(configuration.venvPath);
            logger.warn(
                `Controller interpreter path mismatch! Expected: ${expectedInterpreter.fsPath}, Got: ${existingController.connection.interpreter?.uri.fsPath}. Recreating controller.`
            );

            // Dispose old controller and recreate it
            existingController.dispose();
            this.notebookControllers.delete(notebookKey);
        }

        // Ensure server is running (startServer is idempotent - returns early if already running)
        // Note: startServer() will create the venv if it doesn't exist
        logger.info(`Ensuring server is running for configuration ${configuration.id}`);
        progress.report({ message: 'Starting Deepnote server...' });
        const serverInfo = await this.serverStarter.startServer(
            configuration.pythonInterpreter,
            configuration.venvPath,
            configuration.managedVenv,
            configuration.packages ?? [],
            configuration.id,
            baseFileUri,
            progressToken
        );

        this.notebookEnvironmentsIds.set(notebookKey, configuration.id);

        logger.info(`Server running at ${serverInfo.url}`);

        // Update last used timestamp
        await this.environmentManager.updateLastUsed(configuration.id);

        // Create server provider handle
        const serverProviderHandle: JupyterServerProviderHandle = {
            extensionId: JVSC_EXTENSION_ID,
            id: 'deepnote-server',
            handle: createDeepnoteServerConfigHandle(configuration.id, baseFileUri)
        };

        // Register the server with the provider (one server per PROJECT)
        this.serverProvider.registerServer(serverProviderHandle.handle, serverInfo);
        this.projectServerHandles.set(projectKey, serverProviderHandle.handle);

        const lspInterpreterUri = this.getVenvInterpreterUri(configuration.venvPath);

        const lspInterpreter: PythonEnvironment = {
            uri: lspInterpreterUri,
            id: lspInterpreterUri.fsPath
        } as PythonEnvironment;

        try {
            await this.lspClientManager.startLspClients(serverInfo, notebook.uri, lspInterpreter, progressToken);

            logger.info(`✓ LSP clients started for ${notebookKey}`);
        } catch (error) {
            logger.error(`Failed to start LSP clients for ${notebookKey}:`, error);
        }

        progress.report({ message: 'Connecting to kernel...' });

        const connectionInfo = createJupyterConnectionInfo(
            serverProviderHandle,
            {
                baseUrl: serverInfo.url,
                token: serverInfo.token || '',
                displayName: `Deepnote: ${configuration.name} (${notebookKey})`,
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

        const venvInterpreter = this.getVenvInterpreterUri(configuration.venvPath);

        logger.info(`Using venv path: ${configuration.venvPath.fsPath}`);
        logger.info(`Venv interpreter path: ${venvInterpreter.fsPath}`);

        // CRITICAL: Use unique notebook-based ID (includes query with notebook ID)
        // This ensures each notebook gets its own controller/kernel, even within the same project.
        // When switching environments, addOrUpdate will call updateConnection() on the existing
        // controller instead of creating a new one, avoiding the DISPOSED error.
        const controllerId = `deepnote-notebook-${notebookKey}`;

        // Extract project and notebook titles from metadata for display
        const projectTitle = notebook.metadata?.deepnoteProjectName || 'Untitled Project';

        const newConnectionMetadata = DeepnoteKernelConnectionMetadata.create({
            interpreter: { uri: venvInterpreter, id: venvInterpreter.fsPath },
            kernelSpec,
            baseUrl: serverInfo.url,
            id: controllerId,
            projectFilePath: baseFileUri.toString(),
            serverProviderHandle,
            serverInfo,
            environmentName: configuration.name,
            projectName: projectTitle,
            notebookName: notebookKey
        });

        // Store connection metadata for reuse
        this.notebookConnectionMetadata.set(notebookKey, newConnectionMetadata);

        // Register controller for deepnote notebook type
        const controllers = this.controllerRegistration.addOrUpdate(newConnectionMetadata, [DEEPNOTE_NOTEBOOK_TYPE]);

        if (controllers.length === 0) {
            logger.error('Failed to create Deepnote kernel controller');
            throw new Error('Failed to create Deepnote kernel controller');
        }

        logger.info(`Controller count: ${controllers.length}`);

        const controller = controllers[0];
        logger.info(`Created Deepnote kernel controller: ${controller.id}`);

        // Store the controller for reuse
        this.notebookControllers.set(notebookKey, controller);

        // Prepare init notebook execution
        const projectId = notebook.metadata?.deepnoteProjectId;
        const project = projectId
            ? (this.notebookManager.getOriginalProject(projectId) as DeepnoteFile | undefined)
            : undefined;

        if (project) {
            // Only create requirements.txt if requirements have changed from what's on disk
            const requirements = project.project.settings?.requirements;
            const expectedHash = computeRequirementsHash(requirements);
            const existingFileHash = await this.getExistingRequirementsHash();

            if (expectedHash !== existingFileHash) {
                progress.report({ message: 'Creating requirements.txt...' });
                await this.requirementsHelper.createRequirementsFile(project, progressToken);
                logger.info(`Created/updated requirements.txt for project ${projectId}`);
            } else {
                logger.info(`Skipping requirements.txt creation for project ${projectId} (no changes detected)`);
            }

            if (project.project.initNotebookId && !this.notebookManager.hasInitNotebookBeenRun(projectId!)) {
                this.projectsPendingInitNotebook.set(projectId!, { notebook, project });
                logger.info(`Init notebook will run automatically when kernel starts for project ${projectId}`);
            }
        }

        // Mark controller as protected
        this.controllerRegistration.trackActiveInterpreterControllers([controller]);
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

        // Auto-select the controller
        await this.ensureControllerSelectedForNotebook(notebook, controller, progressToken);

        logger.info(`Successfully set up kernel with configuration: ${configuration.name}`);
        progress.report({ message: 'Kernel ready!' });
    }

    public async ensureControllerSelectedForNotebook(
        notebook: NotebookDocument,
        controller: IVSCodeNotebookController,
        token: CancellationToken
    ): Promise<void> {
        Cancellation.throwIfCanceled(token);

        const alreadySelected = this.controllerRegistration.getSelected(notebook);
        if (alreadySelected?.id === controller.id) {
            logger.info(`Controller ${controller.id} already selected for ${getDisplayPath(notebook.uri)}`);
            controller.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);
            return;
        }

        controller.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

        // notebook.selectKernel needs a NotebookEditor (see findNotebookEditor). Passing the
        // NotebookDocument can fail to bind the controller to the notebook, leaving it without an
        // executable kernel so the first execution requests are silently dropped until VS Code
        // happens to settle — observed as a multi-minute stall before the first cell runs.
        const notebookEditor = await this.findNotebookEditor(notebook);

        await commands.executeCommand('notebook.selectKernel', {
            notebookEditor: notebookEditor ?? notebook,
            id: controller.connection.id,
            // id: controller.controller.id,
            extension: JVSC_EXTENSION_ID
        });
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

    /**
     * Ensure an environment is configured for the notebook before execution.
     * If not configured, shows picker and sets up the kernel.
     * @returns true if environment is ready, false if user cancelled
     */
    public async ensureEnvironmentConfiguredBeforeExecution(
        notebook: NotebookDocument,
        token: CancellationToken
    ): Promise<boolean> {
        Cancellation.throwIfCanceled(token);

        const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
        const notebookKey = notebook.uri.toString();
        const projectKey = baseFileUri.fsPath;

        const existingEnvironmentId = this.notebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri);

        // No environment configured - need to pick one
        if (!existingEnvironmentId) {
            return this.pickAndSetupEnvironment(notebook, baseFileUri, notebookKey, projectKey, token);
        }

        const environment = this.environmentManager.getEnvironment(existingEnvironmentId);

        // Environment no longer exists - remove stale mapping and pick a new one
        if (!environment) {
            logger.info(`Removing stale environment mapping for ${getDisplayPath(notebook.uri)}`);
            await this.notebookEnvironmentMapper.removeEnvironmentForNotebook(baseFileUri);

            return this.pickAndSetupEnvironment(notebook, baseFileUri, notebookKey, projectKey, token);
        }

        const existingController = this.notebookControllers.get(notebookKey);

        // Environment and controller already configured - but verify interpreter path still matches
        if (existingController) {
            if (!this.isControllerInterpreterValid(existingController, environment.venvPath)) {
                const expectedInterpreter = this.getVenvInterpreterUri(environment.venvPath);
                logger.warn(
                    `Controller interpreter path mismatch! Expected: ${expectedInterpreter.fsPath}, Got: ${existingController.connection.interpreter?.uri.fsPath}. Recreating controller.`
                );

                existingController.dispose();
                this.notebookControllers.delete(notebookKey);

                return this.setupKernelForEnvironment(
                    notebook,
                    environment,
                    baseFileUri,
                    notebookKey,
                    projectKey,
                    token
                );
            }

            logger.info(`Environment "${environment.name}" already configured for ${getDisplayPath(notebook.uri)}`);

            return true;
        }

        // Environment exists but controller is missing - set it up
        logger.info(
            `Environment "${environment.name}" configured but controller missing for ${getDisplayPath(
                notebook.uri
            )}, triggering setup`
        );

        return this.setupKernelForEnvironment(notebook, environment, baseFileUri, notebookKey, projectKey, token);
    }

    /**
     * Pick an environment and set up the kernel for a notebook.
     */
    private async pickAndSetupEnvironment(
        notebook: NotebookDocument,
        baseFileUri: Uri,
        notebookKey: string,
        projectKey: string,
        token: CancellationToken
    ): Promise<boolean> {
        Cancellation.throwIfCanceled(token);

        logger.info(`No environment configured for ${getDisplayPath(notebook.uri)}, showing picker`);
        const selectedEnvironment = await this.pickEnvironment(notebook.uri);

        if (!selectedEnvironment) {
            logger.info(`User cancelled environment selection for ${getDisplayPath(notebook.uri)}`);

            return false;
        }

        Cancellation.throwIfCanceled(token);

        await this.notebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, selectedEnvironment.id);

        const result = await this.setupKernelForEnvironment(
            notebook,
            selectedEnvironment,
            baseFileUri,
            notebookKey,
            projectKey,
            token
        );

        if (result) {
            logger.info(`Environment "${selectedEnvironment.name}" configured for ${getDisplayPath(notebook.uri)}`);
        }

        return result;
    }

    /**
     * Set up the kernel for a given environment.
     */
    private async setupKernelForEnvironment(
        notebook: NotebookDocument,
        environment: DeepnoteEnvironment,
        baseFileUri: Uri,
        notebookKey: string,
        projectKey: string,
        token: CancellationToken
    ): Promise<boolean> {
        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Setting up Deepnote kernel...'),
                    cancellable: true
                },
                async (progress, progressToken) => {
                    await this.ensureKernelSelectedWithConfiguration(
                        notebook,
                        environment,
                        baseFileUri,
                        notebookKey,
                        projectKey,
                        progress,
                        progressToken
                    );
                }
            );
        } catch (error) {
            if (token.isCancellationRequested || isCancellationError(error as Error)) {
                logger.info(`Kernel setup cancelled for ${getDisplayPath(notebook.uri)}`);

                return false;
            }
            throw error;
        }

        const createdController = this.notebookControllers.get(notebookKey);

        if (!createdController) {
            logger.warn(
                `Controller not created for "${environment.name}" on ${getDisplayPath(notebook.uri)} after setup`
            );

            return false;
        }

        return true;
    }

    /**
     * Clear the controller selection for a notebook using a specific environment.
     * This is used when deleting an environment to unselect its controller from any open notebooks.
     */
    public clearControllerForEnvironment(notebook: NotebookDocument, environmentId: string): void {
        const selectedController = this.controllerRegistration.getSelected(notebook);
        if (!selectedController || selectedController.connection.kind !== 'startUsingDeepnoteKernel') {
            return;
        }

        const expectedHandle = createDeepnoteServerConfigHandle(environmentId, notebook.uri);

        if (selectedController.connection.serverProviderHandle.handle === expectedHandle) {
            // Unselect the controller by setting affinity to Default
            selectedController.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Default);
            logger.info(
                `Cleared controller for notebook ${getDisplayPath(notebook.uri)} (environment ${environmentId})`
            );
        }
    }

    private getVenvInterpreterUri(venvPath: Uri): Uri {
        return process.platform === 'win32'
            ? Uri.joinPath(venvPath, 'Scripts', 'python.exe')
            : Uri.joinPath(venvPath, 'bin', 'python');
    }

    /**
     * Check if a controller's interpreter path matches the expected venv path.
     * Returns true when no interpreter is present (nothing to validate) or when paths match.
     */
    private isControllerInterpreterValid(
        controller: { connection: { interpreter?: { uri: Uri } } },
        venvPath: Uri
    ): boolean {
        const existingInterpreter = controller.connection.interpreter;

        if (!existingInterpreter) {
            return true;
        }

        const expectedInterpreter = this.getVenvInterpreterUri(venvPath);

        return existingInterpreter.uri.fsPath === expectedInterpreter.fsPath;
    }

    /**
     * Find the NotebookEditor for a given NotebookDocument.
     * Required for properly selecting a kernel with the notebook.selectKernel command.
     * Includes retry logic since the editor might not be visible immediately when the document opens.
     */
    private async findNotebookEditor(notebook: NotebookDocument): Promise<NotebookEditor | undefined> {
        // Try to find immediately
        let editor = window.visibleNotebookEditors.find((e) => e.notebook.uri.toString() === notebook.uri.toString());

        if (editor) {
            return editor;
        }

        // If not found, wait briefly and retry (editor might not be visible yet)
        for (let i = 0; i < NOTEBOOK_EDITOR_RETRY_COUNT; i++) {
            await new Promise((resolve) => setTimeout(resolve, NOTEBOOK_EDITOR_RETRY_DELAY_MS));

            editor = window.visibleNotebookEditors.find((e) => e.notebook.uri.toString() === notebook.uri.toString());

            if (editor) {
                return editor;
            }
        }

        return;
    }

    /**
     * Create and select a placeholder controller for a notebook without a configured environment.
     */
    private async selectPlaceholderController(notebook: NotebookDocument): Promise<void> {
        const placeholder = this.createPlaceholderController(notebook);
        placeholder.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

        const notebookEditor = await this.findNotebookEditor(notebook);

        if (notebookEditor) {
            await commands.executeCommand('notebook.selectKernel', {
                notebookEditor: notebookEditor,
                id: placeholder.id,
                extension: JVSC_EXTENSION_ID
            });
        } else {
            logger.warn(
                `Could not find NotebookEditor for ${getDisplayPath(notebook.uri)}, kernel may not be selected`
            );
        }
    }

    /**
     * Handle kernel selection errors with user-friendly messages and actions
     */
    public async handleKernelSelectionError(error: unknown, notebook: NotebookDocument): Promise<void> {
        if (error instanceof DeepnoteToolkitMissingError) {
            const installAction = l10n.t('Install');
            const changeEnvironmentAction = l10n.t('Change Environment');
            const selectedAction = await window.showWarningMessage(
                l10n.t(
                    'Running Deepnote projects requires deepnote-toolkit[server]=={0} to be installed in the selected environment',
                    DEEPNOTE_TOOLKIT_VERSION
                ),
                { modal: true },
                installAction,
                changeEnvironmentAction
            );

            if (selectedAction === installAction) {
                await this.installToolkitAndNotify(error.venvPath, notebook);
            } else if (selectedAction === changeEnvironmentAction) {
                void commands.executeCommand('deepnote.environments.selectForNotebook', { notebook });
            }

            return;
        }

        // Handle DeepnoteKernelError types with specific guidance
        if (error instanceof DeepnoteKernelError) {
            // Log the technical details
            logger.error(error.getErrorReport());

            // Show user-friendly error with actions
            const showOutputAction = l10n.t('Show Output');
            const copyErrorAction = l10n.t('Copy Error Details');
            const actions: string[] = [showOutputAction, copyErrorAction];

            const troubleshootingHeader = l10n.t('Troubleshooting:');
            const troubleshootingSteps = error.troubleshootingSteps
                .slice(0, 3)
                .map((step, i) => `${i + 1}. ${step}`)
                .join('\n');

            const selectedAction = await window.showErrorMessage(
                `${error.userMessage}\n\n${troubleshootingHeader}\n${troubleshootingSteps}`,
                { modal: false },
                ...actions
            );

            if (selectedAction === showOutputAction) {
                this.outputChannel.show();
            } else if (selectedAction === copyErrorAction) {
                try {
                    await env.clipboard.writeText(error.getErrorReport());
                    void window.showInformationMessage(l10n.t('Error details copied to clipboard'));
                } catch (clipboardError) {
                    logger.error('Failed to copy error details to clipboard', clipboardError);
                    void window.showErrorMessage(l10n.t('Failed to copy error details to clipboard'));
                }
            }

            return;
        }

        // Handle generic errors
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Deepnote kernel error: ${errorMessage}`);

        const showOutputAction = l10n.t('Show Output');
        const selectedAction = await window.showErrorMessage(
            l10n.t('Failed to load Deepnote kernel: {0}', errorMessage),
            { modal: false },
            showOutputAction
        );

        if (selectedAction === showOutputAction) {
            this.outputChannel.show();
        }
    }

    /**
     * Install deepnote-toolkit in an existing venv and rebuild the controller.
     */
    private async installToolkitAndNotify(venvPath: string, notebook: NotebookDocument): Promise<void> {
        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Installing deepnote-toolkit...'),
                    cancellable: true
                },
                async (progress, token) => {
                    await this.toolkitInstaller.installToolkitInExistingVenv(Uri.file(venvPath), token);

                    // After successful installation, rebuild the controller to use the new environment
                    progress.report({ message: l10n.t('Starting kernel...') });
                    await this.rebuildController(notebook, progress, token);
                }
            );

            void window.showInformationMessage(l10n.t('deepnote-toolkit installed successfully'));
        } catch (installError) {
            logger.error('Failed to install deepnote-toolkit', installError);
            const errorMessage = installError instanceof Error ? installError.message : String(installError);

            void window.showErrorMessage(l10n.t('Failed to install deepnote-toolkit: {0}', errorMessage));
        }
    }

    /**
     * Read and hash the existing requirements.txt file if it exists.
     * Returns the same hash format as computeRequirementsHash for comparison.
     */
    private async getExistingRequirementsHash(): Promise<string> {
        try {
            const workspaceFolders = workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return '';
            }

            const requirementsPath = Uri.joinPath(workspaceFolders[0].uri, 'requirements.txt').fsPath;
            const fileExists = await fs.promises
                .access(requirementsPath)
                .then(() => true)
                .catch(() => false);

            if (!fileExists) {
                return '';
            }

            const content = await fs.promises.readFile(requirementsPath, 'utf8');

            // Parse the file into lines (filter out comments) and reuse the hash computation logic
            const requirementsArray = content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith('#'));

            return computeRequirementsHash(requirementsArray);
        } catch (error) {
            logger.warn(`Failed to read existing requirements.txt: ${error}`);
            return '';
        }
    }

    /**
     * Create a placeholder controller for a notebook without a configured environment.
     * Each notebook gets its own placeholder with a unique ID.
     * The placeholder's executeHandler shows the environment picker when user tries to run cells.
     */
    private createPlaceholderController(notebook: NotebookDocument): NotebookController {
        const notebookKey = notebook.uri.toString();

        // Check if we already have one
        const existing = this.placeholderControllers.get(notebookKey);

        if (existing) {
            return existing;
        }

        const controller = notebooks.createNotebookController(
            `deepnote-placeholder-${notebookKey}`,
            DEEPNOTE_NOTEBOOK_TYPE,
            l10n.t('Deepnote: Select Environment')
        );

        controller.supportsExecutionOrder = true;
        controller.supportedLanguages = ['python', 'sql', 'markdown'];

        // Execution handler that shows environment picker when user tries to run without an environment
        controller.executeHandler = async (cells, doc) => {
            logger.info(
                `Placeholder controller execute handler called for ${getDisplayPath(doc.uri)} with ${
                    cells.length
                } cells`
            );

            // Create a cancellation token that cancels when the notebook is closed
            const cts = new CancellationTokenSource();
            const closeListener = workspace.onDidCloseNotebookDocument((closedDoc) => {
                if (closedDoc.uri.toString() === doc.uri.toString()) {
                    logger.info(`Notebook closed during environment setup, cancelling operation`);
                    cts.cancel();
                }
            });

            try {
                const hasEnvironment = await this.ensureEnvironmentConfiguredBeforeExecution(doc, cts.token);

                if (!hasEnvironment) {
                    logger.info(`User cancelled environment selection, not executing cells`);

                    return;
                }

                // Environment is now configured, execute the cells through the kernel
                const docNotebookKey = doc.uri.toString();
                const realController = this.notebookControllers.get(docNotebookKey);

                if (!realController) {
                    logger.error(`No controller found after environment configuration for ${docNotebookKey}`);

                    return;
                }

                logger.info(`Executing ${cells.length} cells through kernel after environment configuration`);

                // Get or create a kernel for this notebook with the new connection
                const kernel = this.kernelProvider.getOrCreate(doc, {
                    metadata: realController.connection,
                    controller: realController.controller,
                    resourceUri: doc.uri
                });

                // Execute cells through the kernel
                const kernelExecution = this.kernelProvider.getKernelExecution(kernel);

                for (const cell of cells) {
                    try {
                        await kernelExecution.executeCell(cell);
                    } catch (cellError) {
                        logger.error(`Error executing cell ${cell.index}`, cellError);
                        // Continue with remaining cells
                    }
                }

                logger.info(`Finished executing ${cells.length} cells`);
            } catch (error) {
                if (isCancellationError(error)) {
                    logger.info(`Environment setup cancelled for ${getDisplayPath(doc.uri)}`);
                } else {
                    logger.error(`Error in placeholder controller execute handler`, error);
                }
            } finally {
                closeListener.dispose();
                cts.dispose();
            }
        };

        this.placeholderControllers.set(notebookKey, controller);

        return controller;
    }
}
