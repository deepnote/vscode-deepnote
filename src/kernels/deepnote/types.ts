// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ServerInfo as RuntimeCoreServerInfo } from '@deepnote/runtime-core';
import * as vscode from 'vscode';

import { serializePythonEnvironment } from '../../platform/api/pythonApi';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { getTelemetrySafeHashedString } from '../../platform/telemetry/helpers';
import { JupyterServerProviderHandle } from '../jupyter/types';
import { IJupyterKernelSpec } from '../types';

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
     * @param managedVenv Whether the venv is managed by this extension (created by us)
     * @param token Cancellation token to cancel the operation
     * @returns The Python interpreter from the venv and the toolkit version
     * @throws {DeepnoteVenvCreationError} If venv creation fails
     * @throws {DeepnoteToolkitInstallError} If toolkit installation fails
     */
    ensureVenvAndToolkit(
        baseInterpreter: PythonEnvironment,
        venvPath: vscode.Uri,
        managedVenv: boolean,
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
     * Install deepnote-toolkit in an existing external venv.
     * This is used when the user has an external venv without toolkit installed.
     * @param venvPath Path to the existing venv
     * @param token Cancellation token to cancel the operation
     * @returns The venv Python interpreter and toolkit version if successful
     * @throws {DeepnoteToolkitInstallError} If toolkit installation fails
     */
    installToolkitInExistingVenv(
        venvPath: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<VenvAndToolkitInstallation>;

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

export enum DeepnoteToolkitDependencyResponse {
    /** The toolkit is present, or the user approved the install and it succeeded. */
    ok,
    /** The user declined or cancelled. Not a failure — nothing should be reported as an error. */
    cancel,
    /** The user chose to point the workspace at a different interpreter instead. */
    selectDifferentInterpreter,
    /** The install ran and did not succeed. */
    failed
}

export const IDeepnoteToolkitDependencyService = Symbol('IDeepnoteToolkitDependencyService');
export interface IDeepnoteToolkitDependencyService {
    /**
     * Ensures deepnote-toolkit is available in the interpreter, prompting for consent first.
     * @param interpreter The interpreter the kernel will run in
     * @param resource The notebook the check is running for, used for logging
     * @param token Cancellation token to cancel the check or the install
     */
    ensureToolkitInstalled(
        interpreter: PythonEnvironment,
        resource: vscode.Uri | undefined,
        token: vscode.CancellationToken
    ): Promise<DeepnoteToolkitDependencyResponse>;
}

export const IDeepnoteServerStarter = Symbol('IDeepnoteServerStarter');
export interface IDeepnoteServerStarter {
    /**
     * Starts a deepnote-toolkit Jupyter server using the active Python interpreter.
     * Handles checking/installing deepnote-toolkit via the IInstaller infrastructure.
     * @param interpreter The Python interpreter to use
     * @param deepnoteFileUri The URI of the .deepnote file
     * @param token Cancellation token to cancel the operation
     * @returns Connection information (URL, port, etc.)
     */
    startServer(
        interpreter: PythonEnvironment,
        deepnoteFileUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<DeepnoteServerInfo>;

    /**
     * Stops the deepnote-toolkit server for a .deepnote file.
     * @param deepnoteFileUri The URI of the .deepnote file
     * @param token Cancellation token to cancel the operation
     */
    stopServer(deepnoteFileUri: vscode.Uri, token?: vscode.CancellationToken): Promise<void>;

    /**
     * Disposes all server processes and resources.
     * Called when the extension is deactivated.
     */
    dispose(): Promise<void>;
}

export interface DeepnoteServerInfo extends RuntimeCoreServerInfo {
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

export const IServerHandleRegistry = Symbol('IServerHandleRegistry');
export interface IServerHandleRegistry {
    /**
     * Get the server handle tracked for a notebook.
     * @param notebookKey The notebook key (see getNotebookKey())
     * @returns The server handle, or undefined if none is tracked
     */
    get(notebookKey: string): string | undefined;

    /**
     * Track the server handle for a notebook.
     * @param notebookKey The notebook key (see getNotebookKey())
     * @param handle The server provider handle
     */
    set(notebookKey: string, handle: string): void;
}

export const IDeepnoteKernelAutoSelector = Symbol('IDeepnoteKernelAutoSelector');
export interface IDeepnoteKernelAutoSelector {
    /**
     * Ensure an environment is configured for the notebook before execution.
     * If not configured, shows picker and sets up the kernel.
     * @returns true if environment is ready, false if user cancelled
     */
    ensureEnvironmentConfiguredBeforeExecution(
        notebook: vscode.NotebookDocument,
        token: vscode.CancellationToken
    ): Promise<boolean>;

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
     * Handle kernel selection errors with user-friendly messages and actions
     * @param error The error to handle
     * @param notebook The notebook document associated with the error
     */
    handleKernelSelectionError(error: unknown, notebook: vscode.NotebookDocument): Promise<void>;

    /**
     * Force rebuild the controller for a notebook by clearing cached controller and metadata.
     * This is used when switching interpreters to ensure a new controller is created.
     * @param notebook The notebook document
     * @param token Cancellation token to cancel the operation
     * @returns Whether the notebook ended up on a running kernel for the resolved interpreter
     */
    rebuildController(
        notebook: vscode.NotebookDocument,
        progress: { report(value: { message?: string; increment?: number }): void },
        token: vscode.CancellationToken
    ): Promise<boolean>;
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

export const DEEPNOTE_DEFAULT_PORT = 8888;
export const DEEPNOTE_NOTEBOOK_TYPE = 'deepnote';
