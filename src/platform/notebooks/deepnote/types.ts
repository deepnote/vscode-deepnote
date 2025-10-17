import { CancellationToken, Event } from 'vscode';
import { IDisposable, Resource } from '../../common/types';
import { EnvironmentVariables } from '../../common/variables/types';
import { IntegrationConfig } from './integrationTypes';

export const IIntegrationStorage = Symbol('IIntegrationStorage');
export interface IIntegrationStorage extends IDisposable {
    /**
     * Event fired when integrations change
     */
    readonly onDidChangeIntegrations: Event<void>;

    getAll(): Promise<IntegrationConfig[]>;
    getIntegrationConfig(integrationId: string): Promise<IntegrationConfig | undefined>;

    /**
     * Get integration configuration for a specific project and integration
     */
    getProjectIntegrationConfig(projectId: string, integrationId: string): Promise<IntegrationConfig | undefined>;

    save(config: IntegrationConfig): Promise<void>;
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
