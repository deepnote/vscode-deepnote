import { IntegrationConfig, IntegrationWithStatus } from './integrationTypes';

export const IIntegrationStorage = Symbol('IIntegrationStorage');
export interface IIntegrationStorage {
    getAll(): Promise<IntegrationConfig[]>;
    get(integrationId: string): Promise<IntegrationConfig | undefined>;
    save(config: IntegrationConfig): Promise<void>;
    delete(integrationId: string): Promise<void>;
    exists(integrationId: string): Promise<boolean>;
    clear(): Promise<void>;
}

export const IIntegrationDetector = Symbol('IIntegrationDetector');
export interface IIntegrationDetector {
    /**
     * Detect all integrations used in the given project
     */
    detectIntegrations(projectId: string): Promise<Map<string, IntegrationWithStatus>>;

    /**
     * Check if a project has any unconfigured integrations
     */
    hasUnconfiguredIntegrations(projectId: string): Promise<boolean>;
}

export const IIntegrationWebviewProvider = Symbol('IIntegrationWebviewProvider');
export interface IIntegrationWebviewProvider {
    /**
     * Show the integration management webview
     */
    show(integrations: Map<string, IntegrationWithStatus>): Promise<void>;
}

export const IIntegrationManager = Symbol('IIntegrationManager');
export interface IIntegrationManager {
    /**
     * Activate the integration manager by registering commands and event listeners
     */
    activate(): void;
}
