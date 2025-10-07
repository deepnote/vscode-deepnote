import { inject, injectable } from 'inversify';
import { Disposable, ViewColumn, WebviewPanel, window } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IIntegrationStorage } from './types';
import { IntegrationConfig, IntegrationStatus, IntegrationWithStatus } from './integrationTypes';

/**
 * Manages the webview panel for integration configuration
 */
@injectable()
export class IntegrationWebviewProvider {
    private currentPanel: WebviewPanel | undefined;

    private readonly disposables: Disposable[] = [];

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage
    ) {}

    /**
     * Show the integration management webview
     */
    public async show(integrations: Map<string, IntegrationWithStatus>): Promise<void> {
        const column = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;

        // If we already have a panel, show it
        if (this.currentPanel) {
            this.currentPanel.reveal(column);
            await this.updateWebview(integrations);
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
        this.currentPanel.webview.html = this.getWebviewContent(integrations);

        // Handle messages from the webview
        this.currentPanel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message, integrations);
            },
            null,
            this.disposables
        );

        // Reset when the current panel is closed
        this.currentPanel.onDidDispose(
            () => {
                this.currentPanel = undefined;
                this.disposables.forEach((d) => d.dispose());
                this.disposables.length = 0;
            },
            null,
            this.disposables
        );

        await this.updateWebview(integrations);
    }

    /**
     * Update the webview with current integration data
     */
    private async updateWebview(integrations: Map<string, IntegrationWithStatus>): Promise<void> {
        if (!this.currentPanel) {
            return;
        }

        const integrationsData = Array.from(integrations.entries()).map(([id, integration]) => ({
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
    private async handleMessage(
        message: { type: string; integrationId?: string; config?: IntegrationConfig },
        integrations: Map<string, IntegrationWithStatus>
    ): Promise<void> {
        logger.debug(`IntegrationWebview: Received message: ${message.type}`);

        switch (message.type) {
            case 'configure':
                if (message.integrationId) {
                    await this.showConfigurationForm(message.integrationId, integrations);
                }
                break;

            case 'save':
                if (message.config) {
                    await this.saveConfiguration(message.config, integrations);
                }
                break;

            case 'delete':
                if (message.integrationId) {
                    await this.deleteConfiguration(message.integrationId, integrations);
                }
                break;

            default:
                logger.warn(`IntegrationWebview: Unknown message type: ${message.type}`);
        }
    }

    /**
     * Show configuration form for an integration
     */
    private async showConfigurationForm(
        integrationId: string,
        integrations: Map<string, IntegrationWithStatus>
    ): Promise<void> {
        const integration = integrations.get(integrationId);
        const existingConfig = integration?.config;

        await this.currentPanel?.webview.postMessage({
            config: existingConfig,
            integrationId,
            type: 'showForm'
        });
    }

    /**
     * Save integration configuration
     */
    private async saveConfiguration(
        config: IntegrationConfig,
        integrations: Map<string, IntegrationWithStatus>
    ): Promise<void> {
        try {
            await this.integrationStorage.save(config);

            // Update the integrations map
            integrations.set(config.id, {
                config,
                status: IntegrationStatus.Connected
            });

            await this.updateWebview(integrations);

            await this.currentPanel?.webview.postMessage({
                message: 'Configuration saved successfully',
                type: 'success'
            });
        } catch (error) {
            logger.error('IntegrationWebview: Failed to save configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: `Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
                type: 'error'
            });
        }
    }

    /**
     * Delete integration configuration
     */
    private async deleteConfiguration(
        integrationId: string,
        integrations: Map<string, IntegrationWithStatus>
    ): Promise<void> {
        try {
            await this.integrationStorage.delete(integrationId);

            // Update the integrations map
            const integration = integrations.get(integrationId);
            if (integration) {
                integrations.set(integrationId, {
                    config: null,
                    status: IntegrationStatus.Disconnected
                });
            }

            await this.updateWebview(integrations);

            await this.currentPanel?.webview.postMessage({
                message: 'Configuration deleted successfully',
                type: 'success'
            });
        } catch (error) {
            logger.error('IntegrationWebview: Failed to delete configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: `Failed to delete configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
                type: 'error'
            });
        }
    }

    /**
     * Get the HTML content for the webview
     */
    private getWebviewContent(_integrations: Map<string, IntegrationWithStatus>): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Deepnote Integrations</title>
    <style>
        body {
            padding: 20px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        .integration-list {
            margin-bottom: 20px;
        }
        .integration-item {
            padding: 12px;
            margin-bottom: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .integration-info {
            flex: 1;
        }
        .integration-name {
            font-weight: bold;
            margin-bottom: 4px;
        }
        .integration-status {
            font-size: 0.9em;
            opacity: 0.8;
        }
        .status-connected {
            color: var(--vscode-testing-iconPassed);
        }
        .status-disconnected {
            color: var(--vscode-testing-iconFailed);
        }
        .integration-actions {
            display: flex;
            gap: 8px;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 14px;
            cursor: pointer;
            border-radius: 2px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .form-container {
            display: none;
            margin-top: 20px;
            padding: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .form-container.visible {
            display: block;
        }
        .form-group {
            margin-bottom: 12px;
        }
        label {
            display: block;
            margin-bottom: 4px;
            font-weight: 500;
        }
        input, textarea {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }
        input:focus, textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .message {
            padding: 12px;
            margin-bottom: 12px;
            border-radius: 4px;
            display: none;
        }
        .message.visible {
            display: block;
        }
        .message.success {
            background: var(--vscode-testing-iconPassed);
            color: var(--vscode-editor-background);
        }
        .message.error {
            background: var(--vscode-testing-iconFailed);
            color: var(--vscode-editor-background);
        }
    </style>
</head>
<body>
    <h1>Deepnote Integrations</h1>
    <div id="message" class="message"></div>
    <div id="integrationList" class="integration-list"></div>
    <div id="formContainer" class="form-container"></div>

    <script nonce="${nonce}">
        ${this.getWebviewScript()}
    </script>
</body>
</html>`;
    }

    private getWebviewScript(): string {
        return `
        (function() {
            const vscode = acquireVsCodeApi();
            let integrations = [];
            let currentIntegrationId = null;

            // Handle messages from the extension
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'update':
                        integrations = message.integrations;
                        renderIntegrations();
                        break;
                    case 'showForm':
                        showConfigurationForm(message.integrationId, message.config);
                        break;
                    case 'success':
                        showMessage(message.message, 'success');
                        hideForm();
                        break;
                    case 'error':
                        showMessage(message.message, 'error');
                        break;
                }
            });

            function renderIntegrations() {
            const listEl = document.getElementById('integrationList');

            // Clear existing content
            while (listEl.firstChild) {
                listEl.removeChild(listEl.firstChild);
            }

            if (!integrations || integrations.length === 0) {
                const noIntegrationsMsg = document.createElement('p');
                noIntegrationsMsg.textContent = 'No integrations found in this project.';
                listEl.appendChild(noIntegrationsMsg);
                return;
            }

            integrations.forEach(integration => {
                const statusClass = integration.status === 'connected' ? 'status-connected' : 'status-disconnected';
                const statusText = integration.status === 'connected' ? 'Connected' : 'Not Configured';
                const configureText = integration.config ? 'Reconfigure' : 'Configure';
                const displayName = integration.config?.name || integration.id;

                // Create item container
                const itemDiv = document.createElement('div');
                itemDiv.className = 'integration-item';

                // Create info section
                const infoDiv = document.createElement('div');
                infoDiv.className = 'integration-info';

                const nameDiv = document.createElement('div');
                nameDiv.className = 'integration-name';
                nameDiv.textContent = displayName;

                const statusDiv = document.createElement('div');
                statusDiv.className = 'integration-status';
                statusDiv.classList.add(statusClass);
                statusDiv.textContent = statusText;

                infoDiv.appendChild(nameDiv);
                infoDiv.appendChild(statusDiv);

                // Create actions section
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'integration-actions';

                const configureBtn = document.createElement('button');
                configureBtn.dataset.action = 'configure';
                configureBtn.dataset.id = integration.id;
                configureBtn.textContent = configureText;

                actionsDiv.appendChild(configureBtn);

                // Add delete button if configured
                if (integration.config) {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'secondary';
                    deleteBtn.dataset.action = 'delete';
                    deleteBtn.dataset.id = integration.id;
                    deleteBtn.textContent = 'Delete';
                    actionsDiv.appendChild(deleteBtn);
                }

                // Assemble the item
                itemDiv.appendChild(infoDiv);
                itemDiv.appendChild(actionsDiv);
                listEl.appendChild(itemDiv);
            });
        }

        // Event delegation for button clicks
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (target.tagName === 'BUTTON' && target.dataset.action) {
                const action = target.dataset.action;
                const integrationId = target.dataset.id;

                if (action === 'configure') {
                    vscode.postMessage({ type: 'configure', integrationId });
                } else if (action === 'delete') {
                    if (confirm('Are you sure you want to delete this integration configuration?')) {
                        vscode.postMessage({ type: 'delete', integrationId });
                    }
                } else if (action === 'save-postgres') {
                    savePostgresConfig();
                } else if (action === 'save-bigquery') {
                    saveBigQueryConfig();
                } else if (action === 'cancel') {
                    hideForm();
                }
            }
        });

        function createFormGroup(labelText, inputElement) {
            const formGroup = document.createElement('div');
            formGroup.className = 'form-group';

            const label = document.createElement('label');
            label.textContent = labelText;

            formGroup.appendChild(label);
            formGroup.appendChild(inputElement);

            return formGroup;
        }

        function showConfigurationForm(integrationId, existingConfig) {
            currentIntegrationId = integrationId;
            const formContainer = document.getElementById('formContainer');

            // Clear existing content
            while (formContainer.firstChild) {
                formContainer.removeChild(formContainer.firstChild);
            }

            // Determine integration type
            let integrationType = existingConfig?.type;
            if (!integrationType) {
                // Show type selection first
                const heading = document.createElement('h2');
                heading.textContent = 'Configure ' + integrationId;
                formContainer.appendChild(heading);

                const select = document.createElement('select');
                select.id = 'integrationType';

                const defaultOption = document.createElement('option');
                defaultOption.value = '';
                defaultOption.textContent = 'Select type...';
                select.appendChild(defaultOption);

                const postgresOption = document.createElement('option');
                postgresOption.value = 'postgres';
                postgresOption.textContent = 'PostgreSQL';
                select.appendChild(postgresOption);

                const bigqueryOption = document.createElement('option');
                bigqueryOption.value = 'bigquery';
                bigqueryOption.textContent = 'BigQuery';
                select.appendChild(bigqueryOption);

                formContainer.appendChild(createFormGroup('Integration Type:', select));
                formContainer.classList.add('visible');

                // Add event listener for type selection
                select.addEventListener('change', (e) => {
                    showTypeSpecificForm(e.target.value);
                });
                return;
            }

            showTypeSpecificForm(integrationType, existingConfig);
        }

        function showTypeSpecificForm(type, config) {
            if (!type) {
                type = document.getElementById('integrationType')?.value;
            }
            if (!type) return;

            const formContainer = document.getElementById('formContainer');

            // Clear existing content
            while (formContainer.firstChild) {
                formContainer.removeChild(formContainer.firstChild);
            }

            if (type === 'postgres') {
                const heading = document.createElement('h2');
                heading.textContent = 'Configure PostgreSQL: ' + currentIntegrationId;
                formContainer.appendChild(heading);

                // Display Name
                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.id = 'name';
                nameInput.value = config?.name || '';
                nameInput.placeholder = 'My PostgreSQL Database';
                nameInput.required = true;
                formContainer.appendChild(createFormGroup('Display Name:', nameInput));

                // Host
                const hostInput = document.createElement('input');
                hostInput.type = 'text';
                hostInput.id = 'host';
                hostInput.value = config?.host || '';
                hostInput.placeholder = 'localhost';
                hostInput.required = true;
                formContainer.appendChild(createFormGroup('Host:', hostInput));

                // Port
                const portInput = document.createElement('input');
                portInput.type = 'number';
                portInput.id = 'port';
                portInput.value = config?.port || 5432;
                portInput.placeholder = '5432';
                portInput.required = true;
                formContainer.appendChild(createFormGroup('Port:', portInput));

                // Database
                const databaseInput = document.createElement('input');
                databaseInput.type = 'text';
                databaseInput.id = 'database';
                databaseInput.value = config?.database || '';
                databaseInput.placeholder = 'mydb';
                databaseInput.required = true;
                formContainer.appendChild(createFormGroup('Database:', databaseInput));

                // Username
                const usernameInput = document.createElement('input');
                usernameInput.type = 'text';
                usernameInput.id = 'username';
                usernameInput.value = config?.username || '';
                usernameInput.placeholder = 'postgres';
                usernameInput.required = true;
                formContainer.appendChild(createFormGroup('Username:', usernameInput));

                // Password
                const passwordInput = document.createElement('input');
                passwordInput.type = 'password';
                passwordInput.id = 'password';
                passwordInput.value = config?.password || '';
                passwordInput.placeholder = 'Enter password';
                passwordInput.required = true;
                formContainer.appendChild(createFormGroup('Password:', passwordInput));

                // Buttons
                const buttonGroup = document.createElement('div');
                buttonGroup.className = 'form-group';

                const saveBtn = document.createElement('button');
                saveBtn.dataset.action = 'save-postgres';
                saveBtn.textContent = 'Save';

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'secondary';
                cancelBtn.dataset.action = 'cancel';
                cancelBtn.textContent = 'Cancel';

                buttonGroup.appendChild(saveBtn);
                buttonGroup.appendChild(cancelBtn);
                formContainer.appendChild(buttonGroup);

            } else if (type === 'bigquery') {
                const heading = document.createElement('h2');
                heading.textContent = 'Configure BigQuery: ' + currentIntegrationId;
                formContainer.appendChild(heading);

                // Display Name
                const nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.id = 'name';
                nameInput.value = config?.name || '';
                nameInput.placeholder = 'My BigQuery Project';
                nameInput.required = true;
                formContainer.appendChild(createFormGroup('Display Name:', nameInput));

                // GCP Project ID
                const projectIdInput = document.createElement('input');
                projectIdInput.type = 'text';
                projectIdInput.id = 'projectId';
                projectIdInput.value = config?.projectId || '';
                projectIdInput.placeholder = 'my-gcp-project';
                projectIdInput.required = true;
                formContainer.appendChild(createFormGroup('GCP Project ID:', projectIdInput));

                // Service Account Credentials
                const credentialsTextarea = document.createElement('textarea');
                credentialsTextarea.id = 'credentials';
                credentialsTextarea.rows = 10;
                credentialsTextarea.placeholder = 'Paste service account JSON here';
                credentialsTextarea.required = true;
                credentialsTextarea.value = config?.credentials || '';
                formContainer.appendChild(createFormGroup('Service Account Credentials (JSON):', credentialsTextarea));

                // Buttons
                const buttonGroup = document.createElement('div');
                buttonGroup.className = 'form-group';

                const saveBtn = document.createElement('button');
                saveBtn.dataset.action = 'save-bigquery';
                saveBtn.textContent = 'Save';

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'secondary';
                cancelBtn.dataset.action = 'cancel';
                cancelBtn.textContent = 'Cancel';

                buttonGroup.appendChild(saveBtn);
                buttonGroup.appendChild(cancelBtn);
                formContainer.appendChild(buttonGroup);
            }

            formContainer.classList.add('visible');
        }

        function savePostgresConfig() {
            const name = document.getElementById('name').value.trim();
            if (!name) {
                showMessage('Display name is required', 'error');
                return;
            }

            const config = {
                id: currentIntegrationId,
                name: name,
                type: 'postgres',
                host: document.getElementById('host').value,
                port: parseInt(document.getElementById('port').value),
                database: document.getElementById('database').value,
                username: document.getElementById('username').value,
                password: document.getElementById('password').value
            };

            vscode.postMessage({ type: 'save', config });
        }

        function saveBigQueryConfig() {
            const name = document.getElementById('name').value.trim();
            if (!name) {
                showMessage('Display name is required', 'error');
                return;
            }

            const credentials = document.getElementById('credentials').value;

            // Validate JSON
            try {
                JSON.parse(credentials);
            } catch (e) {
                showMessage('Invalid JSON in credentials field', 'error');
                return;
            }

            const config = {
                id: currentIntegrationId,
                name: name,
                type: 'bigquery',
                projectId: document.getElementById('projectId').value,
                credentials: credentials
            };

            vscode.postMessage({ type: 'save', config });
        }

        function hideForm() {
            document.getElementById('formContainer').classList.remove('visible');
            currentIntegrationId = null;
        }

        function showMessage(text, type) {
            const messageEl = document.getElementById('message');
            messageEl.textContent = text;
            messageEl.className = 'message visible ' + type;
            setTimeout(() => {
                messageEl.classList.remove('visible');
            }, 5000);
        }
        })();
        `;
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
