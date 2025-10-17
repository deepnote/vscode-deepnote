import { Event } from 'vscode';
import { IDisposable } from '../../common/types';
import { IntegrationConfig } from './integrationTypes';

export const IIntegrationStorage = Symbol('IIntegrationStorage');
export interface IIntegrationStorage extends IDisposable {
    /**
     * Event fired when integrations change
     */
    readonly onDidChangeIntegrations: Event<void>;

    getAll(): Promise<IntegrationConfig[]>;
    get(integrationId: string): Promise<IntegrationConfig | undefined>;

    /**
     * Get integration configuration for a specific project and integration
     */
    getIntegrationConfig(projectId: string, integrationId: string): Promise<IntegrationConfig | undefined>;

    save(config: IntegrationConfig): Promise<void>;
    delete(integrationId: string): Promise<void>;
    exists(integrationId: string): Promise<boolean>;
    clear(): Promise<void>;
}

