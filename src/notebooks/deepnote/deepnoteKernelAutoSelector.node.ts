// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { NotebookDocument, workspace, NotebookControllerAffinity } from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import {
    IDeepnoteKernelAutoSelector,
    IDeepnoteServerStarter,
    IDeepnoteToolkitInstaller,
    DEEPNOTE_NOTEBOOK_TYPE
} from '../../kernels/deepnote/types';
import { DeepnoteKernelConnectionMetadata } from '../../kernels/deepnote/types';
import { IControllerRegistration } from '../controllers/types';
import { JVSC_EXTENSION_ID } from '../../platform/common/constants';
import { getDisplayPath } from '../../platform/common/platform/fs-paths';
import { createInterpreterKernelSpec } from '../../kernels/helpers';
import { JupyterServerProviderHandle } from '../../kernels/jupyter/types';
import { IPythonExtensionChecker } from '../../platform/api/types';

/**
 * Automatically selects and starts Deepnote kernel for .deepnote notebooks
 */
@injectable()
export class DeepnoteKernelAutoSelector implements IDeepnoteKernelAutoSelector, IExtensionSyncActivationService {
    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IControllerRegistration) private readonly controllerRegistration: IControllerRegistration,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(IDeepnoteToolkitInstaller) private readonly toolkitInstaller: IDeepnoteToolkitInstaller,
        @inject(IDeepnoteServerStarter) private readonly serverStarter: IDeepnoteServerStarter,
        @inject(IPythonExtensionChecker) private readonly pythonExtensionChecker: IPythonExtensionChecker
    ) {}

    public activate() {
        // Listen to notebook open events
        workspace.onDidOpenNotebookDocument(this.onDidOpenNotebook, this, this.disposables);

        // Handle currently open notebooks
        workspace.notebookDocuments.forEach((d) => this.onDidOpenNotebook(d));
    }

    private async onDidOpenNotebook(notebook: NotebookDocument) {
        // Only handle deepnote notebooks
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        logger.info(`Deepnote notebook opened: ${getDisplayPath(notebook.uri)}`);

        // Check if a kernel is already selected
        const existingController = this.controllerRegistration.getSelected(notebook);
        if (existingController) {
            logger.info(`Kernel already selected for ${getDisplayPath(notebook.uri)}`);
            return;
        }

        // Auto-select Deepnote kernel
        await this.ensureKernelSelected(notebook);
    }

    public async ensureKernelSelected(notebook: NotebookDocument): Promise<void> {
        try {
            logger.info(`Auto-selecting Deepnote kernel for ${getDisplayPath(notebook.uri)}`);

            // Extract the base file URI (without query parameters)
            // Notebooks from the same .deepnote file have different URIs with ?notebook=id query params
            const baseFileUri = notebook.uri.with({ query: '', fragment: '' });
            logger.info(`Base Deepnote file: ${getDisplayPath(baseFileUri)}`);

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
            const venvInterpreter = await this.toolkitInstaller.ensureInstalled(interpreter, baseFileUri);
            if (!venvInterpreter) {
                logger.error('Failed to set up Deepnote toolkit environment');
                return; // Exit gracefully
            }

            logger.info(`Deepnote toolkit venv ready at: ${getDisplayPath(venvInterpreter.uri)}`);

            // Start the Deepnote server using the venv interpreter
            const serverInfo = await this.serverStarter.getOrStartServer(venvInterpreter, baseFileUri);
            logger.info(`Deepnote server running at ${serverInfo.url}`);

            // Create kernel connection metadata
            const kernelSpec = await createInterpreterKernelSpec(interpreter);
            const serverProviderHandle: JupyterServerProviderHandle = {
                extensionId: JVSC_EXTENSION_ID,
                id: 'deepnote-server',
                handle: 'deepnote-toolkit-server'
            };

            const connectionMetadata = DeepnoteKernelConnectionMetadata.create({
                interpreter,
                kernelSpec,
                baseUrl: serverInfo.url,
                id: `deepnote-kernel-${interpreter.id}`,
                serverProviderHandle
            });

            // Register controller for deepnote notebook type
            const controllers = this.controllerRegistration.addOrUpdate(connectionMetadata, [DEEPNOTE_NOTEBOOK_TYPE]);

            if (controllers.length === 0) {
                logger.error('Failed to create Deepnote kernel controller');
                throw new Error('Failed to create Deepnote kernel controller');
            }

            const controller = controllers[0];
            logger.info(`Created Deepnote kernel controller: ${controller.id}`);

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
