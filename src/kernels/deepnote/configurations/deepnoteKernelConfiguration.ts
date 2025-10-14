import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { DeepnoteServerInfo } from '../types';

/**
 * Represents a Deepnote kernel configuration.
 * This is the runtime model with full objects.
 */
export interface DeepnoteKernelConfiguration {
    /**
     * Unique identifier for this configuration (UUID)
     */
    id: string;

    /**
     * User-friendly name for the configuration
     * Example: "Python 3.11 (Data Science)"
     */
    name: string;

    /**
     * Python interpreter to use for this kernel
     */
    pythonInterpreter: PythonEnvironment;

    /**
     * Path to the virtual environment for this configuration
     */
    venvPath: Uri;

    /**
     * Server information (set when server is running)
     */
    serverInfo?: DeepnoteServerInfo;

    /**
     * Timestamp when this configuration was created
     */
    createdAt: Date;

    /**
     * Timestamp when this configuration was last used
     */
    lastUsedAt: Date;

    /**
     * Optional list of additional packages to install in the venv
     */
    packages?: string[];

    /**
     * Version of deepnote-toolkit installed (if known)
     */
    toolkitVersion?: string;

    /**
     * Optional description for this configuration
     */
    description?: string;
}

/**
 * Serializable state for storing configurations.
 * Uses string paths instead of Uri objects for JSON serialization.
 */
export interface DeepnoteKernelConfigurationState {
    id: string;
    name: string;
    pythonInterpreterPath: string;
    venvPath: string;
    createdAt: string;
    lastUsedAt: string;
    packages?: string[];
    toolkitVersion?: string;
    description?: string;
}

/**
 * Configuration for creating a new kernel configuration
 */
export interface CreateKernelConfigurationOptions {
    name: string;
    pythonInterpreter: PythonEnvironment;
    packages?: string[];
    description?: string;
}

/**
 * Status of a kernel configuration
 */
export enum KernelConfigurationStatus {
    /**
     * Configuration exists but server is not running
     */
    Stopped = 'stopped',

    /**
     * Server is currently starting
     */
    Starting = 'starting',

    /**
     * Server is running and ready
     */
    Running = 'running',

    /**
     * Server encountered an error
     */
    Error = 'error'
}

/**
 * Extended configuration with runtime status information
 */
export interface DeepnoteKernelConfigurationWithStatus extends DeepnoteKernelConfiguration {
    status: KernelConfigurationStatus;
    errorMessage?: string;
}
