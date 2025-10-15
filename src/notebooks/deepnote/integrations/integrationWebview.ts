import { inject, injectable } from 'inversify';
import { Disposable, Uri, ViewColumn, WebviewPanel, window } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IIntegrationStorage, IIntegrationWebviewProvider } from './types';
import { IntegrationConfig, IntegrationStatus, IntegrationWithStatus } from './integrationTypes';

/**
 * Manages the webview panel for integration configuration
 */
@injectable()
export class IntegrationWebviewProvider implements IIntegrationWebviewProvider {
    private currentPanel: WebviewPanel | undefined;

    private readonly disposables: Disposable[] = [];

    private integrations: Map<string, IntegrationWithStatus> = new Map();

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage
    ) {}

    /**
     * Show the integration management webview
     */
    public async show(integrations: Map<string, IntegrationWithStatus>): Promise<void> {
        // Update the stored integrations with the latest data
        this.integrations = integrations;

        const column = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;

        // If we already have a panel, show it
        if (this.currentPanel) {
            this.currentPanel.reveal(column);
            await this.updateWebview();
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
                localResourceRoots: [this.extensionContext.extensionUri]
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

        await this.updateWebview();
    }

    /**
     * Update the webview with current integration data
     */
    private async updateWebview(): Promise<void> {
        if (!this.currentPanel) {
            return;
        }

        const integrationsData = Array.from(this.integrations.entries()).map(([id, integration]) => ({
            config: integration.config,
            id,
            status: integration.status
        }));

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

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: 'Configuration saved successfully',
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to save integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: `Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: 'Configuration deleted successfully',
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to delete integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: `Failed to delete configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
                type: 'error'
            });
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
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
