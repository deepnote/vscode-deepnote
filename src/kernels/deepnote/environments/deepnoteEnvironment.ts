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
     * Whether the venv is managed by this extension (created by us).
     * If true, the venv can be deleted when the environment is removed.
     * If false, the venv is external and should be preserved.
     */
    managedVenv: boolean;

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
    managedVenv?: boolean;
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
