import { inject, injectable } from 'inversify';
import { commands, NotebookDocument, window, workspace } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { logger } from '../../../platform/logging';
import { IIntegrationDetector, IIntegrationStorage } from './types';
import {
    IntegrationStatus,
    IntegrationType,
    PostgresIntegrationConfig,
    BigQueryIntegrationConfig
} from './integrationTypes';

/**
 * Manages integration UI and commands for Deepnote notebooks
 */
@injectable()
export class IntegrationManager {
    // Special integration IDs that should be excluded from management
    private readonly EXCLUDED_INTEGRATION_IDS = new Set(['deepnote-dataframe-sql']);

    private hasIntegrationsContext = 'deepnote.hasIntegrations';

    private hasUnconfiguredIntegrationsContext = 'deepnote.hasUnconfiguredIntegrations';

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationDetector) private readonly integrationDetector: IIntegrationDetector,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage
    ) {}

    public activate(): void {
        // Register the manage integrations command
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ManageIntegrations, () => this.showIntegrationsUI())
        );

        // Listen for active notebook changes to update context
        this.extensionContext.subscriptions.push(window.onDidChangeActiveNotebookEditor(() => this.updateContext()));

        // Listen for notebook document changes
        this.extensionContext.subscriptions.push(workspace.onDidOpenNotebookDocument(() => this.updateContext()));

        this.extensionContext.subscriptions.push(workspace.onDidCloseNotebookDocument(() => this.updateContext()));

        // Initial context update
        void this.updateContext();
    }

    /**
     * Update the context keys based on the active notebook
     */
    private async updateContext(): Promise<void> {
        const activeNotebook = window.activeNotebookEditor?.notebook;

        if (!activeNotebook || activeNotebook.notebookType !== 'deepnote') {
            await commands.executeCommand('setContext', this.hasIntegrationsContext, false);
            await commands.executeCommand('setContext', this.hasUnconfiguredIntegrationsContext, false);
            return;
        }

        // Get the project ID from the notebook metadata
        const projectId = activeNotebook.metadata?.deepnoteProjectId;
        if (!projectId) {
            await commands.executeCommand('setContext', this.hasIntegrationsContext, false);
            await commands.executeCommand('setContext', this.hasUnconfiguredIntegrationsContext, false);
            return;
        }

        // Detect integrations in the project
        const integrations = await this.integrationDetector.detectIntegrations(projectId);
        const hasIntegrations = integrations.size > 0;
        const hasUnconfigured = Array.from(integrations.values()).some(
            (integration) => integration.status === IntegrationStatus.Disconnected
        );

        await commands.executeCommand('setContext', this.hasIntegrationsContext, hasIntegrations);
        await commands.executeCommand('setContext', this.hasUnconfiguredIntegrationsContext, hasUnconfigured);
    }

    /**
     * Show the integrations management UI
     */
    private async showIntegrationsUI(): Promise<void> {
        const activeNotebook = window.activeNotebookEditor?.notebook;

        if (!activeNotebook || activeNotebook.notebookType !== 'deepnote') {
            void window.showErrorMessage('No active Deepnote notebook');
            return;
        }

        const projectId = activeNotebook.metadata?.deepnoteProjectId;
        if (!projectId) {
            void window.showErrorMessage('Cannot determine project ID');
            return;
        }

        logger.debug(`IntegrationManager: Project ID: ${projectId}`);
        logger.trace(`IntegrationManager: Notebook metadata:`, activeNotebook.metadata);

        // Detect integrations in the project
        const integrations = await this.integrationDetector.detectIntegrations(projectId);

        logger.debug(`IntegrationManager: Detected ${integrations.size} integrations`);

        if (integrations.size === 0) {
            // Try to scan cells directly as a fallback
            const cellIntegrations = this.scanCellsForIntegrations(activeNotebook);
            logger.debug(`IntegrationManager: Found ${cellIntegrations.size} integrations by scanning cells directly`);

            if (cellIntegrations.size > 0) {
                void window.showInformationMessage(
                    `Found ${cellIntegrations.size} integrations in cells, but they're not in the project store. This is a bug - check the logs.`
                );
                return;
            }

            void window.showInformationMessage(
                `No integrations found in this project. Project ID: ${projectId}. Check the logs for details.`
            );
            return;
        }

        // For now, show a simple quick pick to select an integration to configure
        // TODO: Replace with a proper webview UI
        const items = Array.from(integrations.entries()).map(([id, integration]) => ({
            label: integration.config?.name || id,
            description: integration.config?.type || 'Unknown type',
            detail:
                integration.status === IntegrationStatus.Connected ? '$(check) Connected' : '$(warning) Not configured',
            integrationId: id,
            integration
        }));

        const selected = await window.showQuickPick(items, {
            placeHolder: 'Select an integration to configure',
            title: 'Manage Integrations'
        });

        if (!selected) {
            return;
        }

        // Show configuration UI for the selected integration
        await this.configureIntegration(selected.integrationId, selected.integration.config?.type);
    }

    /**
     * Scan cells directly for integration metadata (fallback method)
     */
    private scanCellsForIntegrations(notebook: NotebookDocument): Set<string> {
        const integrationIds = new Set<string>();

        for (const cell of notebook.getCells()) {
            const deepnoteMetadata = cell.metadata?.deepnoteMetadata;
            logger.trace(`IntegrationManager: Cell ${cell.index} metadata:`, deepnoteMetadata);

            if (deepnoteMetadata?.sql_integration_id) {
                const integrationId = deepnoteMetadata.sql_integration_id;

                // Skip excluded integrations (e.g., internal DuckDB integration)
                if (this.EXCLUDED_INTEGRATION_IDS.has(integrationId)) {
                    logger.trace(`IntegrationManager: Skipping excluded integration: ${integrationId}`);
                    continue;
                }

                integrationIds.add(integrationId);
                logger.debug(`IntegrationManager: Found integration in cell: ${integrationId}`);
            }
        }

        return integrationIds;
    }

    /**
     * Show configuration UI for a specific integration
     */
    private async configureIntegration(integrationId: string, integrationType?: string): Promise<void> {
        // If type is not known, ask user to select
        let selectedType = integrationType;

        if (!selectedType) {
            const typeSelection = await window.showQuickPick(
                [
                    { label: 'PostgreSQL', value: 'postgres' as const },
                    { label: 'BigQuery', value: 'bigquery' as const }
                ],
                {
                    placeHolder: 'Select integration type',
                    title: `Configure ${integrationId}`
                }
            );

            if (!typeSelection) {
                return;
            }

            selectedType = typeSelection.value;
        }

        // Show configuration form based on type
        if (selectedType === 'postgres') {
            await this.configurePostgres(integrationId);
        } else if (selectedType === 'bigquery') {
            await this.configureBigQuery(integrationId);
        }

        // Update context after configuration
        await this.updateContext();
    }

    /**
     * Configure PostgreSQL integration
     */
    private async configurePostgres(integrationId: string): Promise<void> {
        const host = await window.showInputBox({
            placeHolder: 'localhost',
            prompt: 'PostgreSQL Host',
            validateInput: (value) => (value ? null : 'Host is required')
        });

        if (!host) {
            return;
        }

        const portStr = await window.showInputBox({
            placeHolder: '5432',
            prompt: 'PostgreSQL Port',
            value: '5432',
            validateInput: (value) => {
                const port = parseInt(value, 10);
                return !isNaN(port) && port > 0 && port < 65536 ? null : 'Invalid port number';
            }
        });

        if (!portStr) {
            return;
        }

        const database = await window.showInputBox({
            placeHolder: 'mydb',
            prompt: 'Database Name',
            validateInput: (value) => (value ? null : 'Database name is required')
        });

        if (!database) {
            return;
        }

        const username = await window.showInputBox({
            placeHolder: 'postgres',
            prompt: 'Username',
            validateInput: (value) => (value ? null : 'Username is required')
        });

        if (!username) {
            return;
        }

        const password = await window.showInputBox({
            password: true,
            placeHolder: 'Enter password',
            prompt: 'Password',
            validateInput: (value) => (value ? null : 'Password is required')
        });

        if (!password) {
            return;
        }

        // Save the configuration
        const config: PostgresIntegrationConfig = {
            database,
            host,
            id: integrationId,
            name: integrationId,
            password,
            port: parseInt(portStr, 10),
            type: IntegrationType.Postgres,
            username
        };

        await this.integrationStorage.save(config);

        void window.showInformationMessage(`PostgreSQL integration "${integrationId}" configured successfully`);
    }

    /**
     * Configure BigQuery integration
     */
    private async configureBigQuery(integrationId: string): Promise<void> {
        const projectId = await window.showInputBox({
            placeHolder: 'my-gcp-project',
            prompt: 'GCP Project ID',
            validateInput: (value) => (value ? null : 'Project ID is required')
        });

        if (!projectId) {
            return;
        }

        const credentials = await window.showInputBox({
            password: true,
            placeHolder: 'Paste service account JSON',
            prompt: 'Service Account Credentials (JSON)',
            validateInput: (value) => {
                if (!value) {
                    return 'Credentials are required';
                }
                try {
                    JSON.parse(value);
                    return null;
                } catch {
                    return 'Invalid JSON format';
                }
            }
        });

        if (!credentials) {
            return;
        }

        // Save the configuration
        const config: BigQueryIntegrationConfig = {
            credentials,
            id: integrationId,
            name: integrationId,
            projectId,
            type: IntegrationType.BigQuery
        };

        await this.integrationStorage.save(config);

        void window.showInformationMessage(`BigQuery integration "${integrationId}" configured successfully`);
    }
}
