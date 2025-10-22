import { IntegrationWithStatus } from '../../../platform/notebooks/deepnote/integrationTypes';

// Re-export IIntegrationStorage from platform layer
export { IIntegrationStorage } from '../../../platform/notebooks/deepnote/types';

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
     * @param integrations Map of integration IDs to their status
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     */
    show(integrations: Map<string, IntegrationWithStatus>, selectedIntegrationId?: string): Promise<void>;
}

export const IIntegrationManager = Symbol('IIntegrationManager');
export interface IIntegrationManager {
    /**
     * Activate the integration manager by registering commands and event listeners
     */
    activate(): void;
}
