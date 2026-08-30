// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DeepnoteFile } from '@deepnote/blocks';
import * as fs from 'fs';
import { inject, injectable, named, optional } from 'inversify';
import {
    CancellationToken,
    CancellationTokenSource,
    NotebookControllerAffinity,
    NotebookDocument,
    NotebookEditor,
    ProgressLocation,
    Uri,
    commands,
    env,
    l10n,
    window,
    workspace
} from 'vscode';
import {
    DEEPNOTE_NOTEBOOK_TYPE,
    DeepnoteKernelConnectionMetadata,
    DeepnoteToolkitDependencyResponse,
    IDeepnoteKernelAutoSelector,
    IDeepnoteLspClientManager,
    IDeepnoteServerProvider,
    IDeepnoteServerStarter,
    IDeepnoteToolkitDependencyService,
    IServerHandleRegistry
} from '../../kernels/deepnote/types';
import { createJupyterConnectionInfo } from '../../kernels/jupyter/jupyterUtils';
import { JupyterLabHelper } from '../../kernels/jupyter/session/jupyterLabHelper';
import {
    IJupyterRequestAgentCreator,
    IJupyterRequestCreator,
    JupyterServerProviderHandle
} from '../../kernels/jupyter/types';
import { IJupyterKernelSpec, IKernelProvider } from '../../kernels/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IPythonApiProvider, IPythonExtensionChecker } from '../../platform/api/types';
import { Cancellation, isCancellationError } from '../../platform/common/cancellation';
import { Commands, JVSC_EXTENSION_ID, STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { getDisplayPath } from '../../platform/common/platform/fs-paths.node';
import { IConfigurationService, IDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { disposeAsync } from '../../platform/common/utils';
import { getNotebookKey } from '../../platform/deepnote/deepnoteProjectUtils';
import { createDeepnoteServerConfigHandle } from '../../platform/deepnote/deepnoteServerUtils.node';
import { DeepnoteKernelError } from '../../platform/errors/deepnoteKernelErrors';
import { DataScience } from '../../platform/common/utils/localize';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import {
    getCachedEnvironment,
    getPythonEnvironmentName,
    resolvedPythonEnvToJupyterEnv
} from '../../platform/interpreter/helpers';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IControllerRegistration, IVSCodeNotebookController } from '../controllers/types';
import { IDeepnoteNotebookManager } from '../types';
import { computeRequirementsHash } from './deepnoteProjectUtils';
import { IDeepnoteNotebookInterpreters } from './deepnoteNotebookInterpreters';
import { IDeepnoteRequirementsHelper } from './deepnoteRequirementsHelper.node';

/**
 * Stand-in for the spec the toolkit server will report. The server's own spec replaces it once the
 * kernel is set up; until then it only has to describe the environment for the kernel picker.
 */
const PENDING_KERNEL_SPEC: IJupyterKernelSpec = {
    argv: [],
    display_name: 'Python 3 (ipykernel)',
    executable: 'python',
    language: 'python',
    name: 'python3'
};

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
    // Track interpreter ID for each notebook
    private readonly notebookInterpreterIds = new Map<string, string>();

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
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IDeepnoteRequirementsHelper) private readonly requirementsHelper: IDeepnoteRequirementsHelper,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IServerHandleRegistry) private readonly serverHandleRegistry: IServerHandleRegistry,
        @inject(IDeepnoteToolkitDependencyService)
        private readonly toolkitDependencyService: IDeepnoteToolkitDependencyService,
        @inject(IDeepnoteNotebookInterpreters)
        private readonly notebookInterpreters: IDeepnoteNotebookInterpreters,
        @inject(IPythonApiProvider) private readonly pythonApiProvider: IPythonApiProvider
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

        this.disposables.push(
            commands.registerCommand(Commands.SelectInterpreterForNotebook, () => this.selectInterpreterForNotebook())
        );

        // Handle currently open notebooks - await all async operations
        Promise.all(workspace.notebookDocuments.map((d) => this.onDidOpenNotebook(d))).catch((error) => {
            logger.error(`Error handling open notebooks during activation: ${error}`);
        });
    }

    /**
     * Pins an interpreter to the active notebook and rebuilds its controller on it. Scoped to the one
     * notebook: the Python extension's own selection is workspace-wide and also drives terminals and
     * language features, so it is deliberately left alone.
     */
    private async selectInterpreterForNotebook(): Promise<void> {
        const notebook = window.activeNotebookEditor?.notebook;

        if (!notebook || notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            void window.showWarningMessage(DataScience.selectInterpreterNoActiveNotebook);

            return;
        }

        const api = await this.pythonApiProvider.getNewApi();
        const items = (api?.environments.known ?? [])
            .map((environment) => resolvedPythonEnvToJupyterEnv(getCachedEnvironment(environment)))
            .filter((interpreter): interpreter is PythonEnvironment => interpreter !== undefined)
            .map((interpreter) => ({
                label: getPythonEnvironmentName(interpreter) || getDisplayPath(interpreter.uri),
                description: getDisplayPath(interpreter.uri),
                interpreter
            }));

        if (items.length === 0) {
            void window.showErrorMessage(DataScience.selectInterpreterNoneFound);

            return;
        }

        const selected = await window.showQuickPick(items, {
            placeHolder: DataScience.selectInterpreterForNotebookPlaceholder,
            matchOnDescription: true
        });

        if (!selected) {
            return;
        }

        await this.applyInterpreter(notebook, selected.interpreter);
    }

    /**
     * Pins `interpreter` to the notebook and rebuilds its controller on it.
     *
     * The pin has to be written before the rebuild, which resolves the interpreter itself. So if the
     * rebuild does not take, the previous pin is put back: otherwise the stored interpreter would
     * disagree with the one the notebook is actually running on, and the next plain "run cell" would
     * silently switch it and re-raise whatever prompt was just declined. Declining the toolkit
     * install is the common way in, and it returns rather than throwing.
     */
    public async applyInterpreter(notebook: NotebookDocument, interpreter: PythonEnvironment): Promise<void> {
        const previous = this.notebookInterpreters.get(notebook.uri);

        await this.notebookInterpreters.set(notebook.uri, interpreter.uri);

        let rebuilt = false;

        try {
            rebuilt = await window.withProgress(
                { location: ProgressLocation.Notification, title: DataScience.switchingInterpreter, cancellable: true },
                (progress, token) => this.rebuildController(notebook, progress, token)
            );
        } catch (error) {
            await this.notebookInterpreters.set(notebook.uri, previous);

            if (isCancellationError(error as Error)) {
                logger.info(`Interpreter switch cancelled for ${getDisplayPath(notebook.uri)}`);

                return;
            }

            await this.handleKernelSelectionError(error, notebook);

            return;
        }

        if (!rebuilt) {
            logger.info(
                `Interpreter switch for ${getDisplayPath(notebook.uri)} did not take; restoring the previous selection`
            );
            await this.notebookInterpreters.set(notebook.uri, previous);
        }
    }

    private async onDidOpenNotebook(notebook: NotebookDocument) {
        logger.info(`Notebook opened: ${notebook.uri}, with type: ${notebook.notebookType}`);

        // Only handle deepnote notebooks
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        logger.info(`Deepnote notebook opened: ${getDisplayPath(notebook.uri)}`);

        // Like the Jupyter extension, opening a notebook only registers a controller for the
        // environment; nothing is installed and no server starts until the first execution.
        try {
            await this.registerControllerForNotebook(notebook);
        } catch (error) {
            logger.error(`Failed to offer a Deepnote kernel for ${getDisplayPath(notebook.uri)}`, error);
        }
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
    }

    private onDidCloseNotebook(notebook: NotebookDocument) {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const notebookKey = getNotebookKey(notebook.uri);
        this.notebookConnectionMetadata.delete(notebookKey);
        this.notebookInterpreterIds.delete(notebookKey);
        this.notebookControllers.delete(notebookKey);

        // The language servers are per notebook and outlive it otherwise, one pylsp process per
        // notebook ever opened. The server itself deliberately keeps running; only LSP is torn down,
        // and the next execution starts it again, exactly as it does for a notebook opened fresh.
        this.lspClientManager.stopLspClients(notebook.uri).catch((error) => {
            logger.warn(`Could not stop LSP clients for the closed ${getDisplayPath(notebook.uri)}`, error);
        });

        logger.info(`Deepnote notebook closed, cleaned up: ${getDisplayPath(notebook.uri)}`);
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
    ): Promise<boolean> {
        const notebookKey = getNotebookKey(notebook.uri);

        logger.info(`Switching controller environment for ${getDisplayPath(notebook.uri)}`);

        // Resolved before anything is torn down, so that a notebook already running on this
        // interpreter can be left alone below.
        const interpreter = await this.resolveInterpreter(notebook.uri);

        if (!interpreter) {
            logger.error(`No active Python interpreter found for ${getDisplayPath(notebook.uri)}`);

            return false;
        }

        // Reselecting the interpreter a notebook is already running on: there is nothing to rebuild,
        // and doing it anyway would restart the server and the language servers for no gain. The
        // controller is still re-selected, since the notebook may have been pointed elsewhere since.
        if (this.isKernelReady(notebookKey, interpreter.id)) {
            logger.info(
                `${getDisplayPath(notebook.uri)} already runs on ${getDisplayPath(interpreter.uri)}, nothing to rebuild`
            );
            await this.ensureControllerSelectedForNotebook(notebook, this.notebookControllers.get(notebookKey)!, token);

            return true;
        }

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

        // Capture the old handle but don't unregister it yet: a failed or cancelled switch would
        // strand the still-selected controller on a dead handle.
        const oldServerHandle = this.serverHandleRegistry.get(notebookKey);

        const previousInterpreterId = this.notebookInterpreterIds.get(notebookKey);

        const dependency = await this.toolkitDependencyService.ensureToolkitInstalled(interpreter, notebook.uri, token);

        if (dependency !== DeepnoteToolkitDependencyResponse.ok) {
            logger.info(`deepnote-toolkit unavailable, controller not rebuilt for ${getDisplayPath(notebook.uri)}`);

            return false;
        }

        // Stopping is what lets the new clients be created: startLspClients treats a notebook that
        // already has one as done and would leave it on the old interpreter. It happens here, after
        // every bail-out above, so a switch that never starts does not cost the notebook its language
        // features -- and if the setup below does not take, they go back on the old interpreter.
        await this.lspClientManager.stopLspClients(notebook.uri, token);

        try {
            await this.ensureKernelSelectedWithInterpreter(notebook, interpreter, notebookKey, progress, token);
        } catch (error) {
            await this.restoreLspClients(notebook, previousInterpreterId);

            throw error;
        }

        // Not only on a throw: setup can also give up by returning, and it can fail *after* starting
        // LSP on the new interpreter, which would otherwise leave the notebook's language features
        // pointed at an interpreter the switch never committed to.
        if (!this.isKernelReady(notebookKey, interpreter.id)) {
            await this.restoreLspClients(notebook, previousInterpreterId);

            return false;
        }

        // Setup succeeded. If it registered a new server handle (full setup path), drop the old one.
        // The verified-controller early return reuses the existing handle, so nothing to clear then.
        const newServerHandle = this.serverHandleRegistry.get(notebookKey);

        if (oldServerHandle && oldServerHandle !== newServerHandle) {
            logger.info(`Clearing old server handle from tracking: ${oldServerHandle}`);
            this.serverProvider.unregisterServer(oldServerHandle);
        }

        logger.info(`Controller switched to ${getDisplayPath(interpreter.uri)} for ${getDisplayPath(notebook.uri)}`);

        return true;
    }

    public async ensureKernelSelected(
        notebook: NotebookDocument,
        progress: { report(value: { message?: string; increment?: number }): void },
        token: CancellationToken
    ): Promise<boolean> {
        // notebookKey uniquely identifies THIS NOTEBOOK - the same identity the controller/server use
        const notebookKey = getNotebookKey(notebook.uri);

        // Get the active Python interpreter
        const interpreter = await this.resolveInterpreter(notebook.uri);

        if (!interpreter) {
            logger.warn(`No active Python interpreter found for ${getDisplayPath(notebook.uri)}`);
            return false;
        }

        await this.ensureKernelSelectedWithInterpreter(notebook, interpreter, notebookKey, progress, token);

        return true;
    }

    public async ensureKernelSelectedWithInterpreter(
        notebook: NotebookDocument,
        interpreter: PythonEnvironment,
        notebookKey: string,
        progress: { report(value: { message?: string; increment?: number }): void },
        progressToken: CancellationToken
    ): Promise<void> {
        logger.info(`Setting up kernel using interpreter: ${interpreter.id}`);
        progress.report({ message: `Using interpreter ${getDisplayPath(interpreter.uri)}...` });

        // Check if Python extension is installed
        if (!this.pythonExtensionChecker.isPythonExtensionInstalled) {
            logger.warn('Python extension is not installed. Prompting user to install it.');
            await this.pythonExtensionChecker.showPythonExtensionInstallRequiredPrompt();
            return;
        }

        if (this.isKernelReady(notebookKey, interpreter.id)) {
            logger.info(`Existing controller found for notebook ${getDisplayPath(notebook.uri)}, reusing`);
            await this.ensureControllerSelectedForNotebook(
                notebook,
                this.notebookControllers.get(notebookKey)!,
                progressToken
            );

            return;
        }

        // Ensure server is running (startServer is idempotent - returns early if already running)
        // Server starter handles toolkit check/install via IInstaller internally
        logger.info(`Ensuring server is running for interpreter ${interpreter.id}`);
        progress.report({ message: 'Starting Deepnote server...' });
        const serverInfo = await this.serverStarter.startServer(interpreter, notebook.uri, progressToken);

        this.notebookInterpreterIds.set(notebookKey, interpreter.id);

        logger.info(`Server running at ${serverInfo.url}`);

        // Create server provider handle using interpreter ID
        const serverProviderHandle: JupyterServerProviderHandle = {
            extensionId: JVSC_EXTENSION_ID,
            id: 'deepnote-server',
            handle: createDeepnoteServerConfigHandle(interpreter.id, notebook.uri)
        };

        // Register the server with the provider (one server per PROJECT)
        this.serverProvider.registerServer(serverProviderHandle.handle, serverInfo);
        this.serverHandleRegistry.set(notebookKey, serverProviderHandle.handle);

        // Use the active interpreter directly for LSP (it already has deepnote-toolkit installed)
        try {
            await this.lspClientManager.startLspClients(notebook.uri, interpreter, progressToken);

            logger.info(`✓ LSP clients started for ${notebookKey}`);
        } catch (error) {
            logger.error(`Failed to start LSP clients for ${notebookKey}:`, error);
        }

        progress.report({ message: 'Connecting to kernel...' });

        const displayName = `Deepnote: ${getDisplayPath(interpreter.uri)} (${notebookKey})`;

        const connectionInfo = createJupyterConnectionInfo(
            serverProviderHandle,
            {
                baseUrl: serverInfo.url,
                token: serverInfo.token || '',
                displayName,
                authorizationHeader: {}
            },
            this.requestCreator,
            this.requestAgentCreator,
            this.configService,
            notebook.uri
        );

        const sessionManager = JupyterLabHelper.create(connectionInfo.settings);
        let kernelSpec;
        try {
            const kernelSpecs = await sessionManager.getKernelSpecs();
            logger.info(`Available kernel specs on Deepnote server: ${kernelSpecs.map((s) => s.name).join(', ')}`);

            // Select the default Python kernel (ipykernel-provided python3 spec)
            kernelSpec = this.selectKernelSpec(kernelSpecs);

            logger.info(`✓ Using kernel spec: ${kernelSpec.name} (${kernelSpec.display_name})`);
        } finally {
            await disposeAsync(sessionManager);
        }

        progress.report({ message: 'Finalizing kernel setup...' });

        logger.info(`Using interpreter: ${interpreter.uri.fsPath}`);

        // CRITICAL: Use unique notebook-based ID (includes query with notebook ID)
        // This ensures each notebook gets its own controller/kernel, even within the same project.
        // When switching environments, addOrUpdate will call updateConnection() on the existing
        // controller instead of creating a new one, avoiding the DISPOSED error.
        const controllerId = `deepnote-notebook-${notebookKey}`;

        const newConnectionMetadata = DeepnoteKernelConnectionMetadata.create({
            interpreter,
            kernelSpec,
            baseUrl: serverInfo.url,
            id: controllerId,
            projectFilePath: getNotebookKey(notebook.uri),
            serverProviderHandle,
            serverInfo,
            environmentName: getDisplayPath(interpreter.uri),
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

        const projectId = notebook.metadata?.deepnoteProjectId;
        const notebookId = notebook.metadata?.deepnoteNotebookId;
        const project =
            projectId && notebookId
                ? (this.notebookManager.getProjectForNotebook(projectId, notebookId) as DeepnoteFile | undefined)
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

        logger.info(`Successfully set up kernel with interpreter: ${interpreter.id}`);
        progress.report({ message: 'Kernel ready!' });
    }

    public async ensureControllerSelectedForNotebook(
        notebook: NotebookDocument,
        controller: IVSCodeNotebookController,
        token: CancellationToken
    ): Promise<void> {
        Cancellation.throwIfCanceled(token);

        // Identity, not id: a Deepnote controller id is derived from the notebook URI, so a disposed
        // controller and the one replacing it share one. Matching on id would skip selectKernel and
        // leave the notebook bound to the dead controller.
        if (this.controllerRegistration.getSelected(notebook) === controller) {
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

        if (!notebookEditor) {
            logger.warn(
                `Could not find NotebookEditor for ${getDisplayPath(notebook.uri)}, kernel may not be selected`
            );
            return;
        }

        await commands.executeCommand('notebook.selectKernel', {
            notebookEditor,
            id: controller.connection.id,
            extension: JVSC_EXTENSION_ID
        });
    }

    /**
     * Select the default Python kernel spec from the server.
     * Extracted for testability.
     * @param kernelSpecs Available kernel specs from the server
     * @returns The selected kernel spec
     * @throws Error if no suitable kernel spec is found
     */
    public selectKernelSpec(kernelSpecs: IJupyterKernelSpec[]): IJupyterKernelSpec {
        const kernelSpec =
            kernelSpecs.find((s) => s.language === 'python') ||
            kernelSpecs.find((s) => s.name === 'python3') ||
            kernelSpecs[0];

        if (!kernelSpec) {
            throw new Error('No kernel specs available on Deepnote server');
        }

        return kernelSpec;
    }

    /**
     * Ensure an environment is configured for the notebook before execution.
     * Uses the active Python interpreter and the IInstaller infrastructure.
     * @returns true if environment is ready, false if user cancelled
     */
    public async ensureEnvironmentConfiguredBeforeExecution(
        notebook: NotebookDocument,
        token: CancellationToken
    ): Promise<boolean> {
        Cancellation.throwIfCanceled(token);

        const notebookKey = getNotebookKey(notebook.uri);

        const interpreter = await this.resolveInterpreter(notebook.uri);

        if (!interpreter) {
            logger.warn(`No active Python interpreter found for ${getDisplayPath(notebook.uri)}`);
            return false;
        }

        if (this.isKernelReady(notebookKey, interpreter.id)) {
            logger.info(`Controller already configured for ${getDisplayPath(notebook.uri)}`);

            return true;
        }

        // Consent before installing into the user's interpreter. Declining or cancelling is not a
        // failure: execution simply does not proceed and no error UI is raised.
        let dependency: DeepnoteToolkitDependencyResponse;

        try {
            dependency = await this.toolkitDependencyService.ensureToolkitInstalled(interpreter, notebook.uri, token);
        } catch (error) {
            if (token.isCancellationRequested || isCancellationError(error as Error)) {
                logger.info(`deepnote-toolkit install cancelled for ${getDisplayPath(notebook.uri)}`);

                return false;
            }

            await this.handleKernelSelectionError(error, notebook);

            return false;
        }

        if (dependency === DeepnoteToolkitDependencyResponse.failed) {
            await this.handleKernelSelectionError(
                new Error(l10n.t('Failed to install {0}.', 'deepnote-toolkit')),
                notebook
            );

            return false;
        }

        if (dependency !== DeepnoteToolkitDependencyResponse.ok) {
            logger.info(
                `deepnote-toolkit unavailable for ${getDisplayPath(notebook.uri)} (${
                    DeepnoteToolkitDependencyResponse[dependency]
                }), kernel not started`
            );

            return false;
        }

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Setting up Deepnote kernel...'),
                    cancellable: true
                },
                async (progress, progressToken) => {
                    await this.ensureKernelSelectedWithInterpreter(
                        notebook,
                        interpreter,
                        notebookKey,
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

        return !!this.notebookControllers.get(notebookKey);
    }

    /**
     * Puts the notebook's language features back on the interpreter it was using before a switch that
     * did not complete. Best effort: the notebook still has a working kernel either way, so a failure
     * to restart LSP is logged rather than raised over whatever caused the switch to fail.
     */
    private async restoreLspClients(notebook: NotebookDocument, interpreterId: string | undefined): Promise<void> {
        if (!interpreterId) {
            return;
        }

        try {
            const interpreter = await this.interpreterService.getInterpreterDetails(interpreterId);

            if (!interpreter) {
                return;
            }

            // Stop first: a failure late in the setup can leave clients already running on the new
            // interpreter, and startLspClients treats a live client as nothing to do.
            await this.lspClientManager.stopLspClients(notebook.uri);
            await this.lspClientManager.startLspClients(notebook.uri, interpreter);
        } catch (error) {
            logger.warn(`Could not restore LSP clients for ${getDisplayPath(notebook.uri)}`, error);
        }
    }

    /**
     * The interpreter this notebook runs on: the one pinned to it if that still resolves, otherwise
     * the workspace's active interpreter. A pin that no longer resolves (its venv was deleted, say)
     * falls back rather than failing, so the notebook stays runnable.
     */
    private async resolveInterpreter(notebookUri: Uri): Promise<PythonEnvironment | undefined> {
        const pinned = this.notebookInterpreters.get(notebookUri);

        if (pinned) {
            const interpreter = await this.interpreterService.getInterpreterDetails(pinned);

            if (interpreter) {
                return interpreter;
            }

            logger.warn(
                `Interpreter pinned to ${getDisplayPath(notebookUri)} no longer resolves (${getDisplayPath(
                    pinned
                )}); using the active interpreter`
            );
        }

        return this.interpreterService.getActiveInterpreter(notebookUri);
    }

    /**
     * True when the notebook's controller is bound to a running server for this interpreter. A
     * controller registered at open time carries no baseUrl and is deliberately not "ready".
     */
    private isKernelReady(notebookKey: string, interpreterId: string): boolean {
        return (
            this.notebookControllers.has(notebookKey) &&
            this.notebookInterpreterIds.get(notebookKey) === interpreterId &&
            !!this.notebookConnectionMetadata.get(notebookKey)?.baseUrl
        );
    }

    /**
     * Registers a controller for the notebook's active interpreter without starting anything, so the
     * notebook has a real, correctly named kernel to select the moment it opens. Its connection
     * carries no baseUrl; the first execution starts the server and updates it in place.
     */
    private async registerControllerForNotebook(notebook: NotebookDocument): Promise<void> {
        const interpreter = await this.resolveInterpreter(notebook.uri);

        if (!interpreter) {
            logger.warn(`No active Python interpreter for ${getDisplayPath(notebook.uri)}, no kernel offered`);

            return;
        }

        const notebookKey = getNotebookKey(notebook.uri);
        const connection = DeepnoteKernelConnectionMetadata.create({
            interpreter,
            kernelSpec: PENDING_KERNEL_SPEC,
            baseUrl: '',
            id: `deepnote-notebook-${notebookKey}`,
            projectFilePath: notebookKey,
            serverProviderHandle: {
                extensionId: JVSC_EXTENSION_ID,
                id: 'deepnote-server',
                handle: createDeepnoteServerConfigHandle(interpreter.id, notebook.uri)
            },
            environmentName: getDisplayPath(interpreter.uri),
            notebookName: notebookKey
        });

        const [controller] = this.controllerRegistration.addOrUpdate(connection, [DEEPNOTE_NOTEBOOK_TYPE]);

        if (!controller) {
            logger.error(`Failed to register a Deepnote controller for ${getDisplayPath(notebook.uri)}`);

            return;
        }

        this.notebookConnectionMetadata.set(notebookKey, connection);
        this.notebookInterpreterIds.set(notebookKey, interpreter.id);
        this.notebookControllers.set(notebookKey, controller);
        this.controllerRegistration.trackActiveInterpreterControllers([controller]);

        const cts = new CancellationTokenSource();

        try {
            await this.ensureControllerSelectedForNotebook(notebook, controller, cts.token);
        } finally {
            cts.dispose();
        }
    }

    /**
     * Find the NotebookEditor for a given NotebookDocument.
     * Required for properly selecting a kernel with the notebook.selectKernel command.
     * Includes retry logic since the editor might not be visible immediately when the document opens.
     */
    private async findNotebookEditor(notebook: NotebookDocument): Promise<NotebookEditor | undefined> {
        let editor = window.visibleNotebookEditors.find(
            (e) => getNotebookKey(e.notebook.uri) === getNotebookKey(notebook.uri)
        );

        if (editor) {
            return editor;
        }

        for (let i = 0; i < NOTEBOOK_EDITOR_RETRY_COUNT; i++) {
            await new Promise((resolve) => setTimeout(resolve, NOTEBOOK_EDITOR_RETRY_DELAY_MS));

            editor = window.visibleNotebookEditors.find(
                (e) => getNotebookKey(e.notebook.uri) === getNotebookKey(notebook.uri)
            );

            if (editor) {
                return editor;
            }
        }

        return;
    }

    /**
     * Handle kernel selection errors with user-friendly messages and actions
     */
    public async handleKernelSelectionError(error: unknown, notebook: NotebookDocument): Promise<void> {
        // A user-initiated Stop is not a failure, so it must not raise the error UI.
        if (error instanceof Error && isCancellationError(error)) {
            logger.info(`Kernel selection cancelled for ${getDisplayPath(notebook.uri)}`);

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
}
