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
     * @param baseInterpreter The base Python interpreter to use for creating the venv
     * @param deepnoteFileUri The URI of the .deepnote file (used to create a unique venv per file)
     * @param token Cancellation token to cancel the operation
     * @returns The Python interpreter from the venv
     * @throws {DeepnoteVenvCreationError} If venv creation fails
     * @throws {DeepnoteToolkitInstallError} If toolkit installation fails
     */
    ensureInstalled(
        baseInterpreter: PythonEnvironment,
        deepnoteFileUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<PythonEnvironment>;

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
     * Starts or gets an existing deepnote-toolkit Jupyter server.
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
     * Stops the deepnote-toolkit server if running.
     * @param deepnoteFileUri The URI of the .deepnote file
     */
    stopServer(deepnoteFileUri: vscode.Uri): Promise<void>;

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

export const DEEPNOTE_TOOLKIT_VERSION = '0.2.30.post30';
export const DEEPNOTE_TOOLKIT_WHEEL_URL = `https://deepnote-staging-runtime-artifactory.s3.amazonaws.com/deepnote-toolkit-packages/${DEEPNOTE_TOOLKIT_VERSION}/deepnote_toolkit-${DEEPNOTE_TOOLKIT_VERSION}-py3-none-any.whl`;
export const DEEPNOTE_DEFAULT_PORT = 8888;
export const DEEPNOTE_NOTEBOOK_TYPE = 'deepnote';
