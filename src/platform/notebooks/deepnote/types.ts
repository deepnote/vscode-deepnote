import { CancellationToken, Event } from 'vscode';
import { IDisposable, Resource } from '../../common/types';
import { EnvironmentVariables } from '../../common/variables/types';
import { LegacyIntegrationConfig } from './integrationTypes';

/**
 * Settings for select input blocks
 */
export interface SelectInputSettings {
    allowMultipleValues: boolean;
    allowEmptyValue: boolean;
    selectType: 'from-options' | 'from-variable';
    options: string[];
    selectedVariable: string;
}

/**
 * Message types for select input settings webview
 */
export type SelectInputWebviewMessage =
    | { type: 'init'; settings: SelectInputSettings }
    | { type: 'save'; settings: SelectInputSettings }
    | { type: 'locInit'; locStrings: Record<string, string> }
    | { type: 'cancel' };

export const IIntegrationStorage = Symbol('IIntegrationStorage');
export interface IIntegrationStorage extends IDisposable {
    /**
     * Event fired when integrations change
     */
    readonly onDidChangeIntegrations: Event<void>;

    getAll(): Promise<LegacyIntegrationConfig[]>;

    /**
     * Retrieves the global (non-project-scoped) integration configuration by integration ID.
     *
     * This method returns integration configurations that are stored globally and shared
     * across all projects. These configurations are stored in VSCode's SecretStorage and
     * are scoped to the user's machine.
     *
     * This differs from `getProjectIntegrationConfig()` which returns project-scoped
     * configurations that are specific to a particular Deepnote project and stored
     * within the project's YAML file.
     *
     * @param integrationId - The unique identifier of the integration to retrieve
     * @returns A Promise that resolves to:
     *          - The `IntegrationConfig` object if a global configuration exists for the given ID
     *          - `undefined` if no global configuration exists for the given integration ID
     */
    getIntegrationConfig(integrationId: string): Promise<LegacyIntegrationConfig | undefined>;

    /**
     * Get integration configuration for a specific project and integration
     */
    getProjectIntegrationConfig(projectId: string, integrationId: string): Promise<LegacyIntegrationConfig | undefined>;

    save(config: LegacyIntegrationConfig): Promise<void>;
    delete(integrationId: string): Promise<void>;
    exists(integrationId: string): Promise<boolean>;
    clear(): Promise<void>;
}

export const ISqlIntegrationEnvVarsProvider = Symbol('ISqlIntegrationEnvVarsProvider');
export interface ISqlIntegrationEnvVarsProvider {
    /**
     * Event fired when environment variables change
     */
    readonly onDidChangeEnvironmentVariables: Event<Resource>;

    /**
     * Get environment variables for SQL integrations used in the given notebook.
     */
    getEnvironmentVariables(resource: Resource, token?: CancellationToken): Promise<EnvironmentVariables>;
}
