import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { DeepnoteServerInfo } from '../types';

/**
 * Represents a Deepnote kernel environment.
 * This is the runtime model with full objects.
 */
export interface DeepnoteEnvironment {
    /**
     * Unique identifier for this environment (UUID)
     */
    id: string;

    /**
     * User-friendly name for the environment
     * Example: "Python 3.11 (Data Science)"
     */
    name: string;

    /**
     * Python interpreter to use for this kernel
     */
    pythonInterpreter: PythonEnvironment;

    /**
     * Path to the virtual environment for this environment
     */
    venvPath: Uri;

    /**
     * Server information (set when server is running)
     */
    serverInfo?: DeepnoteServerInfo;

    /**
     * Timestamp when this environment was created
     */
    createdAt: Date;

    /**
     * Timestamp when this environment was last used
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
     * Optional description for this environment
     */
    description?: string;
}

/**
 * Serializable state for storing environments.
 * Uses string paths instead of Uri objects for JSON serialization.
 */
export interface DeepnoteEnvironmentState {
    id: string;
    name: string;
    pythonInterpreterPath: {
        id: string;
        uri: string;
    };
    venvPath: string;
    createdAt: string;
    lastUsedAt: string;
    packages?: string[];
    toolkitVersion?: string;
    description?: string;
}

/**
 * Options for creating a new kernel environment
 */
export interface CreateDeepnoteEnvironmentOptions {
    name: string;
    pythonInterpreter: PythonEnvironment;
    packages?: string[];
    description?: string;
}

/**
 * Status of a kernel environment
 */
export enum EnvironmentStatus {
    /**
     * Environment exists but server is not running
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
 * Extended environment with runtime status information
 */
export interface DeepnoteEnvironmentWithStatus extends DeepnoteEnvironment {
    status: EnvironmentStatus;
    errorMessage?: string;
}
