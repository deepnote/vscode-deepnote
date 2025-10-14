// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { IJupyterKernelSpec } from '../types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { JupyterServerProviderHandle } from '../jupyter/types';
import { serializePythonEnvironment } from '../../platform/api/pythonApi';
import { getTelemetrySafeHashedString } from '../../platform/telemetry/helpers';

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
    public readonly interpreter?: PythonEnvironment;
    public readonly serverProviderHandle: JupyterServerProviderHandle;
    public readonly serverInfo?: DeepnoteServerInfo; // Store server info for connection

    private constructor(options: {
        interpreter?: PythonEnvironment;
        kernelSpec: IJupyterKernelSpec;
        baseUrl: string;
        id: string;
        serverProviderHandle: JupyterServerProviderHandle;
        serverInfo?: DeepnoteServerInfo;
    }) {
        this.interpreter = options.interpreter;
        this.kernelSpec = options.kernelSpec;
        this.baseUrl = options.baseUrl;
        this.id = options.id;
        this.serverProviderHandle = options.serverProviderHandle;
        this.serverInfo = options.serverInfo;
    }

    public static create(options: {
        interpreter?: PythonEnvironment;
        kernelSpec: IJupyterKernelSpec;
        baseUrl: string;
        id: string;
        serverProviderHandle: JupyterServerProviderHandle;
        serverInfo?: DeepnoteServerInfo;
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
     * Configuration-based method.
     * @param baseInterpreter The base Python interpreter to use for creating the venv
     * @param venvPath The path where the venv should be created
     * @param token Cancellation token to cancel the operation
     * @returns The Python interpreter from the venv if installed successfully, undefined otherwise
     */
    ensureVenvAndToolkit(
        baseInterpreter: PythonEnvironment,
        venvPath: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<PythonEnvironment | undefined>;

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
     * Legacy method: Ensures deepnote-toolkit is installed in a dedicated virtual environment.
     * File-based method (for backward compatibility).
     * @param baseInterpreter The base Python interpreter to use for creating the venv
     * @param deepnoteFileUri The URI of the .deepnote file (used to create a unique venv per file)
     * @param token Cancellation token to cancel the operation
     * @returns The Python interpreter from the venv if installed successfully, undefined otherwise
     */
    ensureInstalled(
        baseInterpreter: PythonEnvironment,
        deepnoteFileUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<PythonEnvironment | undefined>;

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
     * Starts a deepnote-toolkit Jupyter server for a configuration.
     * Configuration-based method.
     * @param interpreter The Python interpreter to use
     * @param venvPath The path to the venv
     * @param configurationId The configuration ID (for server management)
     * @param token Cancellation token to cancel the operation
     * @returns Connection information (URL, port, etc.)
     */
    startServer(
        interpreter: PythonEnvironment,
        venvPath: vscode.Uri,
        configurationId: string,
        token?: vscode.CancellationToken
    ): Promise<DeepnoteServerInfo>;

    /**
     * Stops the deepnote-toolkit server for a configuration.
     * @param configurationId The configuration ID
     */
    stopServer(configurationId: string): Promise<void>;

    /**
     * Legacy method: Starts or gets an existing deepnote-toolkit Jupyter server.
     * File-based method (for backward compatibility).
     * @param interpreter The Python interpreter to use
     * @param deepnoteFileUri The URI of the .deepnote file (for server management per file)
     * @param token Cancellation token to cancel the operation
     * @returns Connection information (URL, port, etc.)
     */
    getOrStartServer(
        interpreter: PythonEnvironment,
        deepnoteFileUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<DeepnoteServerInfo>;

    /**
     * Disposes all server processes and resources.
     * Called when the extension is deactivated.
     */
    dispose(): Promise<void>;
}

export interface DeepnoteServerInfo {
    url: string;
    port: number;
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
    ensureKernelSelected(notebook: vscode.NotebookDocument, token?: vscode.CancellationToken): Promise<void>;
}

export const IDeepnoteConfigurationManager = Symbol('IDeepnoteConfigurationManager');
export interface IDeepnoteConfigurationManager {
    /**
     * Initialize the manager by loading configurations from storage
     */
    initialize(): Promise<void>;

    /**
     * Create a new kernel configuration
     */
    createConfiguration(
        options: import('./configurations/deepnoteKernelConfiguration').CreateKernelConfigurationOptions
    ): Promise<import('./configurations/deepnoteKernelConfiguration').DeepnoteKernelConfiguration>;

    /**
     * Get all configurations
     */
    listConfigurations(): import('./configurations/deepnoteKernelConfiguration').DeepnoteKernelConfiguration[];

    /**
     * Get a specific configuration by ID
     */
    getConfiguration(
        id: string
    ): import('./configurations/deepnoteKernelConfiguration').DeepnoteKernelConfiguration | undefined;

    /**
     * Get configuration with status information
     */
    getConfigurationWithStatus(
        id: string
    ): import('./configurations/deepnoteKernelConfiguration').DeepnoteKernelConfigurationWithStatus | undefined;

    /**
     * Update a configuration's metadata
     */
    updateConfiguration(
        id: string,
        updates: Partial<
            Pick<
                import('./configurations/deepnoteKernelConfiguration').DeepnoteKernelConfiguration,
                'name' | 'packages' | 'description'
            >
        >
    ): Promise<void>;

    /**
     * Delete a configuration
     */
    deleteConfiguration(id: string): Promise<void>;

    /**
     * Start the Jupyter server for a configuration
     */
    startServer(id: string): Promise<void>;

    /**
     * Stop the Jupyter server for a configuration
     */
    stopServer(id: string): Promise<void>;

    /**
     * Restart the Jupyter server for a configuration
     */
    restartServer(id: string): Promise<void>;

    /**
     * Update the last used timestamp for a configuration
     */
    updateLastUsed(id: string): Promise<void>;

    /**
     * Event fired when configurations change
     */
    onDidChangeConfigurations: vscode.Event<void>;

    /**
     * Dispose of all resources
     */
    dispose(): void;
}

export const DEEPNOTE_TOOLKIT_VERSION = '0.2.30.post30';
export const DEEPNOTE_TOOLKIT_WHEEL_URL = `https://deepnote-staging-runtime-artifactory.s3.amazonaws.com/deepnote-toolkit-packages/${DEEPNOTE_TOOLKIT_VERSION}/deepnote_toolkit-${DEEPNOTE_TOOLKIT_VERSION}-py3-none-any.whl`;
export const DEEPNOTE_DEFAULT_PORT = 8888;
export const DEEPNOTE_NOTEBOOK_TYPE = 'deepnote';
