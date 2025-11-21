// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { serializePythonEnvironment } from '../../platform/api/pythonApi';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { getTelemetrySafeHashedString } from '../../platform/telemetry/helpers';
import { JupyterServerProviderHandle } from '../jupyter/types';
import { IJupyterKernelSpec } from '../types';
import { CreateDeepnoteEnvironmentOptions, DeepnoteEnvironment } from './environments/deepnoteEnvironment';

export interface VenvAndToolkitInstallation {
    pythonInterpreter: PythonEnvironment;
    toolkitVersion: string;
}

/**
 * Connection metadata for Deepnote Toolkit Kernels.
 * This kernel connects to a Jupyter server started by deepnote-toolkit.
 */
export class DeepnoteKernelConnectionMetadata {
    public readonly kernelModel?: undefined;
    public readonly kind = 'startUsingDeepnoteKernel' as const;
    public readonly id: string;
    public readonly kernelSpec: IJupyterKernelSpec;
    public readonly baseUrl: string;
    public readonly projectFilePath?: string;
    public readonly interpreter?: PythonEnvironment;
    public readonly serverProviderHandle: JupyterServerProviderHandle;
    public readonly serverInfo?: DeepnoteServerInfo; // Store server info for connection
    public readonly environmentName?: string; // Name of the Deepnote environment for display purposes
    public readonly projectName?: string; // Name of the project for display purposes
    public readonly notebookName?: string; // Name of the notebook for display purposes

    private constructor(options: {
        interpreter?: PythonEnvironment;
        kernelSpec: IJupyterKernelSpec;
        baseUrl: string;
        id: string;
        projectFilePath?: string;
        serverProviderHandle: JupyterServerProviderHandle;
        serverInfo?: DeepnoteServerInfo;
        environmentName?: string;
        projectName?: string;
        notebookName?: string;
    }) {
        this.interpreter = options.interpreter;
        this.kernelSpec = options.kernelSpec;
        this.baseUrl = options.baseUrl;
        this.id = options.id;
        this.projectFilePath = options.projectFilePath;
        this.serverProviderHandle = options.serverProviderHandle;
        this.serverInfo = options.serverInfo;
        this.environmentName = options.environmentName;
        this.projectName = options.projectName;
        this.notebookName = options.notebookName;
    }

    public static create(options: {
        interpreter?: PythonEnvironment;
        kernelSpec: IJupyterKernelSpec;
        baseUrl: string;
        id: string;
        projectFilePath?: string;
        serverProviderHandle: JupyterServerProviderHandle;
        serverInfo?: DeepnoteServerInfo;
        environmentName?: string;
        projectName?: string;
        notebookName?: string;
    }) {
        return new DeepnoteKernelConnectionMetadata(options);
    }

    public getHashId() {
        return getTelemetrySafeHashedString(this.id);
    }

    public toJSON() {
        return {
            id: this.id,
            kernelSpec: this.kernelSpec,
            interpreter: serializePythonEnvironment(this.interpreter),
            baseUrl: this.baseUrl,
            kind: this.kind,
            serverProviderHandle: this.serverProviderHandle
        };
    }
}

export const IDeepnoteToolkitInstaller = Symbol('IDeepnoteToolkitInstaller');
export interface IDeepnoteToolkitInstaller {
    /**
     * Ensures deepnote-toolkit is installed in a dedicated virtual environment.
     * Environment-based method.
     * @param baseInterpreter The base Python interpreter to use for creating the venv
     * @param venvPath The path where the venv should be created
     * @param token Cancellation token to cancel the operation
     * @returns The Python interpreter from the venv and the toolkit version
     * @throws {DeepnoteVenvCreationError} If venv creation fails
     * @throws {DeepnoteToolkitInstallError} If toolkit installation fails
     */
    ensureVenvAndToolkit(
        baseInterpreter: PythonEnvironment,
        venvPath: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<VenvAndToolkitInstallation>;

    /**
     * Install additional packages in the venv.
     * @param venvPath The path to the venv
     * @param packages List of package names to install
     * @param token Cancellation token to cancel the operation
     */
    installAdditionalPackages(
        venvPath: vscode.Uri,
        packages: string[],
        token?: vscode.CancellationToken
    ): Promise<void>;

    /**
     * Gets the venv Python interpreter if toolkit is installed, undefined otherwise.
     * @param deepnoteFileUri The URI of the .deepnote file
     */
    getVenvInterpreter(deepnoteFileUri: vscode.Uri): Promise<PythonEnvironment | undefined>;

    /**
     * Gets the hash for the venv directory/kernel spec name based on file path.
     * @param deepnoteFileUri The URI of the .deepnote file
     * @returns The hash string used for venv directory and kernel spec naming
     */
    getVenvHash(deepnoteFileUri: vscode.Uri): string;
}

export const IDeepnoteServerStarter = Symbol('IDeepnoteServerStarter');
export interface IDeepnoteServerStarter {
    /**
     * Starts a deepnote-toolkit Jupyter server for a kernel environment.
     * Environment-based method.
     * @param interpreter The Python interpreter to use
     * @param venvPath The path to the venv
     * @param environmentId The environment ID (for server management)
     * @param deepnoteFileUri The URI of the .deepnote file
     * @param token Cancellation token to cancel the operation
     * @returns Connection information (URL, port, etc.)
     */
    startServer(
        interpreter: PythonEnvironment,
        venvPath: vscode.Uri,
        additionalPackages: string[],
        environmentId: string,
        deepnoteFileUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<DeepnoteServerInfo>;

    /**
     * Stops the deepnote-toolkit server for a kernel environment.
     * @param environmentId The environment ID
     * @param token Cancellation token to cancel the operation
     */
    // stopServer(environmentId: string, token?: vscode.CancellationToken): Promise<void>;
    stopServer(deepnoteFileUri: vscode.Uri, token?: vscode.CancellationToken): Promise<void>;

    /**
     * Disposes all server processes and resources.
     * Called when the extension is deactivated.
     */
    dispose(): Promise<void>;
}

export interface DeepnoteServerInfo {
    url: string;
    jupyterPort: number;
    lspPort: number;
    token?: string;
}

export const IDeepnoteServerProvider = Symbol('IDeepnoteServerProvider');
export interface IDeepnoteServerProvider {
    /**
     * Register a server for a specific handle.
     * Called by DeepnoteKernelAutoSelector when a server is started.
     */
    registerServer(handle: string, serverInfo: DeepnoteServerInfo): void;

    /**
     * Unregister a server for a specific handle.
     * Called when the server is no longer needed or notebook is closed.
     * No-op if the handle doesn't exist.
     */
    unregisterServer(handle: string): void;
}

export const IDeepnoteKernelAutoSelector = Symbol('IDeepnoteKernelAutoSelector');
export interface IDeepnoteKernelAutoSelector {
    /**
     * Automatically selects and starts a Deepnote kernel for the given notebook.
     * @param notebook The notebook document
     * @param token Cancellation token to cancel the operation
     */
    ensureKernelSelected(
        notebook: vscode.NotebookDocument,
        progress: { report(value: { message?: string; increment?: number }): void },
        token: vscode.CancellationToken
    ): Promise<boolean>;

    /**
     * Force rebuild the controller for a notebook by clearing cached controller and metadata.
     * This is used when switching environments to ensure a new controller is created.
     * @param notebook The notebook document
     * @param token Cancellation token to cancel the operation
     */
    rebuildController(
        notebook: vscode.NotebookDocument,
        progress: { report(value: { message?: string; increment?: number }): void },
        token: vscode.CancellationToken
    ): Promise<void>;

    /**
     * Clear the controller selection for a notebook using a specific environment.
     * This is used when deleting an environment to unselect its controller from any open notebooks.
     * @param notebook The notebook document
     * @param environmentId The environment ID
     */
    clearControllerForEnvironment(notebook: vscode.NotebookDocument, environmentId: string): void;
}

export const IDeepnoteEnvironmentManager = Symbol('IDeepnoteEnvironmentManager');
export interface IDeepnoteEnvironmentManager {
    /**
     * Initialize the manager by loading environments from storage
     */
    initialize(): Promise<void>;

    /**
     * Wait for initialization to complete
     */
    waitForInitialization(): Promise<void>;

    /**
     * Create a new kernel environment
     * @param options Environment creation options
     * @param token Cancellation token to cancel the operation
     */
    createEnvironment(
        options: CreateDeepnoteEnvironmentOptions,
        token?: vscode.CancellationToken
    ): Promise<DeepnoteEnvironment>;

    /**
     * Get all environments
     */
    listEnvironments(): DeepnoteEnvironment[];

    /**
     * Get a specific environment by ID
     */
    getEnvironment(id: string): DeepnoteEnvironment | undefined;

    /**
     * Update an environment's metadata
     */
    updateEnvironment(
        id: string,
        updates: Partial<Pick<DeepnoteEnvironment, 'name' | 'packages' | 'description'>>
    ): Promise<void>;

    /**
     * Delete an environment
     * @param id The environment ID
     * @param token Cancellation token to cancel the operation
     */
    deleteEnvironment(id: string, token?: vscode.CancellationToken): Promise<void>;

    /**
     * Update the last used timestamp for an environment
     */
    updateLastUsed(id: string): Promise<void>;

    /**
     * Event fired when environments change
     */
    onDidChangeEnvironments: vscode.Event<void>;

    /**
     * Dispose of all resources
     */
    dispose(): void;
}

export const IDeepnoteNotebookEnvironmentMapper = Symbol('IDeepnoteNotebookEnvironmentMapper');
export interface IDeepnoteNotebookEnvironmentMapper {
    /**
     * Get the environment ID selected for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @returns Environment ID, or undefined if not set
     */
    getEnvironmentForNotebook(notebookUri: vscode.Uri): string | undefined;

    /**
     * Set the environment for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     * @param environmentId The environment ID
     */
    setEnvironmentForNotebook(notebookUri: vscode.Uri, environmentId: string): Promise<void>;

    /**
     * Remove the environment mapping for a notebook
     * @param notebookUri The notebook URI (without query/fragment)
     */
    removeEnvironmentForNotebook(notebookUri: vscode.Uri): Promise<void>;

    /**
     * Get all notebooks using a specific environment
     * @param environmentId The environment ID
     * @returns Array of notebook URIs
     */
    getNotebooksUsingEnvironment(environmentId: string): vscode.Uri[];
}

export const IDeepnoteLspClientManager = Symbol('IDeepnoteLspClientManager');
export interface IDeepnoteLspClientManager {
    /**
     * Start LSP clients for a Deepnote server
     * @param serverInfo Server information
     * @param notebookUri The notebook URI for which to start LSP clients
     * @param interpreter The Python interpreter from the venv
     * @param token Optional cancellation token to cancel the operation
     */
    startLspClients(
        serverInfo: DeepnoteServerInfo,
        notebookUri: vscode.Uri,
        interpreter: PythonEnvironment,
        token?: vscode.CancellationToken
    ): Promise<void>;

    /**
     * Stop LSP clients for a notebook
     * @param notebookUri The notebook URI
     * @param token Optional cancellation token to cancel the operation
     */
    stopLspClients(notebookUri: vscode.Uri, token?: vscode.CancellationToken): Promise<void>;

    /**
     * Stop all LSP clients
     * @param token Optional cancellation token to cancel the operation
     */
    stopAllClients(token?: vscode.CancellationToken): Promise<void>;
}

export const DEEPNOTE_TOOLKIT_VERSION = '1.1.0';
export const DEEPNOTE_DEFAULT_PORT = 8888;
export const DEEPNOTE_NOTEBOOK_TYPE = 'deepnote';
