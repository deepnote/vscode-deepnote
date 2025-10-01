// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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

    private constructor(options: {
        interpreter?: PythonEnvironment;
        kernelSpec: IJupyterKernelSpec;
        baseUrl: string;
        id: string;
        serverProviderHandle: JupyterServerProviderHandle;
    }) {
        this.interpreter = options.interpreter;
        this.kernelSpec = options.kernelSpec;
        this.baseUrl = options.baseUrl;
        this.id = options.id;
        this.serverProviderHandle = options.serverProviderHandle;
    }

    public static create(options: {
        interpreter?: PythonEnvironment;
        kernelSpec: IJupyterKernelSpec;
        baseUrl: string;
        id: string;
        serverProviderHandle: JupyterServerProviderHandle;
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
     * @returns The Python interpreter from the venv if installed successfully, undefined otherwise
     */
    ensureInstalled(baseInterpreter: PythonEnvironment): Promise<PythonEnvironment | undefined>;

    /**
     * Gets the venv Python interpreter if toolkit is installed, undefined otherwise.
     */
    getVenvInterpreter(): Promise<PythonEnvironment | undefined>;
}

export const IDeepnoteServerStarter = Symbol('IDeepnoteServerStarter');
export interface IDeepnoteServerStarter {
    /**
     * Starts or gets an existing deepnote-toolkit Jupyter server.
     * @param interpreter The Python interpreter to use
     * @returns Connection information (URL, port, etc.)
     */
    getOrStartServer(interpreter: PythonEnvironment): Promise<DeepnoteServerInfo>;

    /**
     * Stops the deepnote-toolkit server if running.
     */
    stopServer(): Promise<void>;
}

export interface DeepnoteServerInfo {
    url: string;
    port: number;
    token?: string;
}

export const IDeepnoteKernelAutoSelector = Symbol('IDeepnoteKernelAutoSelector');
export interface IDeepnoteKernelAutoSelector {
    /**
     * Automatically selects and starts a Deepnote kernel for the given notebook.
     */
    ensureKernelSelected(notebook: any): Promise<void>;
}

export const DEEPNOTE_TOOLKIT_WHEEL_URL =
    'https://deepnote-staging-runtime-artifactory.s3.amazonaws.com/deepnote-toolkit-packages/0.2.30.post19/deepnote_toolkit-0.2.30.post19-py3-none-any.whl';
export const DEEPNOTE_DEFAULT_PORT = 8888;
export const DEEPNOTE_NOTEBOOK_TYPE = 'deepnote';
