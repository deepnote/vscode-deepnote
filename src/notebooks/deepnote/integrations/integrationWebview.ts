import { inject, injectable } from 'inversify';
import { Disposable, l10n, Uri, ViewColumn, WebviewPanel, window } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import * as localize from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { LocalizedMessages, SharedMessages } from '../../../messageTypes';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { IIntegrationStorage, IIntegrationWebviewProvider } from './types';
import {
    INTEGRATION_TYPE_TO_DEEPNOTE,
    IntegrationConfig,
    IntegrationStatus,
    IntegrationWithStatus,
    RawIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';

/**
 * Manages the webview panel for integration configuration
 */
@injectable()
export class IntegrationWebviewProvider implements IIntegrationWebviewProvider {
    private currentPanel: WebviewPanel | undefined;

    private readonly disposables: Disposable[] = [];

    private integrations: Map<string, IntegrationWithStatus> = new Map();

    private projectId: string | undefined;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager
    ) {}

    /**
     * Show the integration management webview
     * @param projectId The Deepnote project ID
     * @param integrations Map of integration IDs to their status
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     */
    public async show(
        projectId: string,
        integrations: Map<string, IntegrationWithStatus>,
        selectedIntegrationId?: string
    ): Promise<void> {
        // Update the stored integrations and project ID with the latest data
        this.projectId = projectId;
        this.integrations = integrations;

        const column = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;

        // If we already have a panel, show it
        if (this.currentPanel) {
            this.currentPanel.reveal(column);
            await this.updateWebview();

            // If a specific integration was requested, show its configuration form
            if (selectedIntegrationId) {
                await this.showConfigurationForm(selectedIntegrationId);
            }
            return;
        }

        // Create a new panel
        this.currentPanel = window.createWebviewPanel(
            'deepnoteIntegrations',
            'Deepnote Integrations',
            column || ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionContext.extensionUri],
                enableForms: true
            }
        );

        // Set the webview's initial html content
        this.currentPanel.webview.html = this.getWebviewContent();

        // Handle messages from the webview
        this.currentPanel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Reset when the current panel is closed
        this.currentPanel.onDidDispose(
            () => {
                this.currentPanel = undefined;
                this.integrations = new Map();
                this.disposables.forEach((d) => d.dispose());
                this.disposables.length = 0;
            },
            null,
            this.disposables
        );

        await this.sendLocStrings();
        await this.updateWebview();

        // If a specific integration was requested, show its configuration form
        if (selectedIntegrationId) {
            await this.showConfigurationForm(selectedIntegrationId);
        }
    }

    /**
     * Send localization strings to the webview
     */
    private async sendLocStrings(): Promise<void> {
        if (!this.currentPanel) {
            return;
        }

        const locStrings: Partial<LocalizedMessages> = {
            integrationsTitle: localize.Integrations.title,
            integrationsNoIntegrationsFound: localize.Integrations.noIntegrationsFound,
            integrationsConnected: localize.Integrations.connected,
            integrationsNotConfigured: localize.Integrations.notConfigured,
            integrationsConfigure: localize.Integrations.configure,
            integrationsReconfigure: localize.Integrations.reconfigure,
            integrationsReset: localize.Integrations.reset,
            integrationsConfirmResetTitle: localize.Integrations.confirmResetTitle,
            integrationsConfirmResetMessage: localize.Integrations.confirmResetMessage,
            integrationsConfirmResetDetails: localize.Integrations.confirmResetDetails,
            integrationsConfigureTitle: localize.Integrations.configureTitle,
            integrationsPostgresTypeLabel: localize.Integrations.postgresTypeLabel,
            integrationsBigQueryTypeLabel: localize.Integrations.bigQueryTypeLabel,
            integrationsSnowflakeTypeLabel: localize.Integrations.snowflakeTypeLabel,
            integrationsCancel: localize.Integrations.cancel,
            integrationsSave: localize.Integrations.save,
            integrationsRequiredField: localize.Integrations.requiredField,
            integrationsOptionalField: localize.Integrations.optionalField,
            integrationsPostgresNameLabel: localize.Integrations.postgresNameLabel,
            integrationsPostgresNamePlaceholder: localize.Integrations.postgresNamePlaceholder,
            integrationsPostgresHostLabel: localize.Integrations.postgresHostLabel,
            integrationsPostgresHostPlaceholder: localize.Integrations.postgresHostPlaceholder,
            integrationsPostgresPortLabel: localize.Integrations.postgresPortLabel,
            integrationsPostgresPortPlaceholder: localize.Integrations.postgresPortPlaceholder,
            integrationsPostgresDatabaseLabel: localize.Integrations.postgresDatabaseLabel,
            integrationsPostgresDatabasePlaceholder: localize.Integrations.postgresDatabasePlaceholder,
            integrationsPostgresUsernameLabel: localize.Integrations.postgresUsernameLabel,
            integrationsPostgresUsernamePlaceholder: localize.Integrations.postgresUsernamePlaceholder,
            integrationsPostgresPasswordLabel: localize.Integrations.postgresPasswordLabel,
            integrationsPostgresPasswordPlaceholder: localize.Integrations.postgresPasswordPlaceholder,
            integrationsPostgresSslLabel: localize.Integrations.postgresSslLabel,
            integrationsBigQueryNameLabel: localize.Integrations.bigQueryNameLabel,
            integrationsBigQueryNamePlaceholder: localize.Integrations.bigQueryNamePlaceholder,
            integrationsBigQueryProjectIdLabel: localize.Integrations.bigQueryProjectIdLabel,
            integrationsBigQueryProjectIdPlaceholder: localize.Integrations.bigQueryProjectIdPlaceholder,
            integrationsBigQueryCredentialsLabel: localize.Integrations.bigQueryCredentialsLabel,
            integrationsBigQueryCredentialsPlaceholder: localize.Integrations.bigQueryCredentialsPlaceholder,
            integrationsBigQueryCredentialsRequired: localize.Integrations.bigQueryCredentialsRequired,
            integrationsSnowflakeNameLabel: localize.Integrations.snowflakeNameLabel,
            integrationsSnowflakeNamePlaceholder: localize.Integrations.snowflakeNamePlaceholder,
            integrationsSnowflakeAccountLabel: localize.Integrations.snowflakeAccountLabel,
            integrationsSnowflakeAccountPlaceholder: localize.Integrations.snowflakeAccountPlaceholder,
            integrationsSnowflakeAuthMethodLabel: localize.Integrations.snowflakeAuthMethodLabel,
            integrationsSnowflakeAuthMethodSubLabel: localize.Integrations.snowflakeAuthMethodSubLabel,
            integrationsSnowflakeAuthMethodUsernamePassword: localize.Integrations.snowflakeAuthMethodUsernamePassword,
            integrationsSnowflakeAuthMethodKeyPair: localize.Integrations.snowflakeAuthMethodKeyPair,
            integrationsSnowflakeUnsupportedAuthMethod: localize.Integrations.snowflakeUnsupportedAuthMethod,
            integrationsSnowflakeUsernameLabel: localize.Integrations.snowflakeUsernameLabel,
            integrationsSnowflakePasswordLabel: localize.Integrations.snowflakePasswordLabel,
            integrationsSnowflakePasswordPlaceholder: localize.Integrations.snowflakePasswordPlaceholder,
            integrationsSnowflakeServiceAccountUsernameLabel:
                localize.Integrations.snowflakeServiceAccountUsernameLabel,
            integrationsSnowflakeServiceAccountUsernameHelp: localize.Integrations.snowflakeServiceAccountUsernameHelp,
            integrationsSnowflakePrivateKeyLabel: localize.Integrations.snowflakePrivateKeyLabel,
            integrationsSnowflakePrivateKeyHelp: localize.Integrations.snowflakePrivateKeyHelp,
            integrationsSnowflakePrivateKeyPlaceholder: localize.Integrations.snowflakePrivateKeyPlaceholder,
            integrationsSnowflakePrivateKeyPassphraseLabel: localize.Integrations.snowflakePrivateKeyPassphraseLabel,
            integrationsSnowflakePrivateKeyPassphraseHelp: localize.Integrations.snowflakePrivateKeyPassphraseHelp,
            integrationsSnowflakeDatabaseLabel: localize.Integrations.snowflakeDatabaseLabel,
            integrationsSnowflakeDatabasePlaceholder: localize.Integrations.snowflakeDatabasePlaceholder,
            integrationsSnowflakeRoleLabel: localize.Integrations.snowflakeRoleLabel,
            integrationsSnowflakeRolePlaceholder: localize.Integrations.snowflakeRolePlaceholder,
            integrationsSnowflakeWarehouseLabel: localize.Integrations.snowflakeWarehouseLabel,
            integrationsSnowflakeWarehousePlaceholder: localize.Integrations.snowflakeWarehousePlaceholder,
            integrationsUnnamedIntegration: localize.Integrations.unnamedIntegration('{0}')
        };

        await this.currentPanel.webview.postMessage({
            type: SharedMessages.LocInit,
            locStrings: locStrings
        });
    }

    /**
     * Update the webview with current integration data
     */
    private async updateWebview(): Promise<void> {
        if (!this.currentPanel) {
            logger.debug('IntegrationWebviewProvider: No current panel, skipping update');
            return;
        }

        const integrationsData = Array.from(this.integrations.entries()).map(([id, integration]) => ({
            config: integration.config,
            id,
            integrationName: integration.integrationName,
            integrationType: integration.integrationType,
            status: integration.status
        }));
        logger.debug(`IntegrationWebviewProvider: Sending ${integrationsData.length} integrations to webview`);

        await this.currentPanel.webview.postMessage({
            integrations: integrationsData,
            type: 'update'
        });
    }

    /**
     * Handle messages from the webview
     */
    private async handleMessage(message: {
        type: string;
        integrationId?: string;
        config?: IntegrationConfig;
    }): Promise<void> {
        switch (message.type) {
            case 'configure':
                if (message.integrationId) {
                    await this.showConfigurationForm(message.integrationId);
                }
                break;
            case 'save':
                if (message.integrationId && message.config) {
                    await this.saveConfiguration(message.integrationId, message.config);
                }
                break;
            case 'delete':
                if (message.integrationId) {
                    await this.deleteConfiguration(message.integrationId);
                }
                break;
        }
    }

    /**
     * Show the configuration form for an integration
     */
    private async showConfigurationForm(integrationId: string): Promise<void> {
        const integration = this.integrations.get(integrationId);
        if (!integration) {
            return;
        }

        await this.currentPanel?.webview.postMessage({
            config: integration.config,
            integrationId,
            integrationName: integration.integrationName,
            integrationType: integration.integrationType,
            type: 'showForm'
        });
    }

    /**
     * Save the configuration for an integration
     */
    private async saveConfiguration(integrationId: string, config: IntegrationConfig): Promise<void> {
        try {
            await this.integrationStorage.save(config);

            // Update local state
            const integration = this.integrations.get(integrationId);
            if (integration) {
                integration.config = config;
                integration.status = IntegrationStatus.Connected;
                this.integrations.set(integrationId, integration);
            }

            // Update the project's integrations list
            await this.updateProjectIntegrationsList();

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: l10n.t('Configuration saved successfully'),
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to save integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to save configuration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });
        }
    }

    /**
     * Delete the configuration for an integration
     */
    private async deleteConfiguration(integrationId: string): Promise<void> {
        try {
            await this.integrationStorage.delete(integrationId);

            // Update local state
            const integration = this.integrations.get(integrationId);
            if (integration) {
                integration.config = null;
                integration.status = IntegrationStatus.Disconnected;
                this.integrations.set(integrationId, integration);
            }

            // Update the project's integrations list
            await this.updateProjectIntegrationsList();

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: l10n.t('Configuration deleted successfully'),
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to delete integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to delete configuration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });
        }
    }

    /**
     * Update the project's integrations list based on current integrations
     */
    private async updateProjectIntegrationsList(): Promise<void> {
        if (!this.projectId) {
            logger.warn('IntegrationWebviewProvider: No project ID available, skipping project update');
            return;
        }

        // Build the integrations list from current integrations
        const projectIntegrations: ProjectIntegration[] = Array.from(this.integrations.entries())
            .map(([id, integration]): ProjectIntegration | null => {
                // Get the integration type from config or integration metadata
                const type = integration.config?.type || integration.integrationType;
                if (!type) {
                    logger.warn(`IntegrationWebviewProvider: No type found for integration ${id}, skipping`);
                    return null;
                }

                // Map to Deepnote integration type
                const deepnoteType: RawIntegrationType | undefined = INTEGRATION_TYPE_TO_DEEPNOTE[type];
                if (!deepnoteType) {
                    logger.warn(`IntegrationWebviewProvider: Cannot map type ${type} for integration ${id}, skipping`);
                    return null;
                }

                return {
                    id,
                    name: integration.config?.name || integration.integrationName || id,
                    type: deepnoteType
                };
            })
            .filter((integration): integration is ProjectIntegration => integration !== null);

        logger.debug(
            `IntegrationWebviewProvider: Updating project ${this.projectId} with ${projectIntegrations.length} integrations`
        );

        // Update the project in the notebook manager
        const success = this.notebookManager.updateProjectIntegrations(this.projectId, projectIntegrations);

        if (!success) {
            logger.error(
                `IntegrationWebviewProvider: Failed to update integrations for project ${this.projectId} - project not found`
            );
            void window.showErrorMessage(
                l10n.t('Failed to update integrations: project not found. Please reopen the notebook and try again.')
            );
        }
    }

    /**
     * Get the HTML content for the webview (React-based)
     */
    private getWebviewContent(): string {
        if (!this.currentPanel) {
            return '';
        }

        const webview = this.currentPanel.webview;
        const nonce = this.getNonce();

        // Get URIs for the React app
        const scriptUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'integrations',
                'index.js'
            )
        );
        const styleUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'integrations',
                'integrations.css'
            )
        );
        const codiconUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'react-common',
                'codicon',
                'codicon.css'
            )
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link rel="stylesheet" href="${codiconUri}">
    <link rel="stylesheet" href="${styleUri}">
    <title>Deepnote Integrations</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
