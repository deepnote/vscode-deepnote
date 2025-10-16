import { inject, injectable } from 'inversify';
import { commands, NotebookDocument, window, workspace } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { logger } from '../../../platform/logging';
import { IIntegrationDetector, IIntegrationManager, IIntegrationStorage, IIntegrationWebviewProvider } from './types';
import { IntegrationStatus, IntegrationWithStatus } from './integrationTypes';
import { BlockWithIntegration, scanBlocksForIntegrations } from './integrationUtils';

/**
 * Manages integration UI and commands for Deepnote notebooks
 */
@injectable()
export class IntegrationManager implements IIntegrationManager {
    private hasIntegrationsContext = 'deepnote.hasIntegrations';

    private hasUnconfiguredIntegrationsContext = 'deepnote.hasUnconfiguredIntegrations';

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationDetector) private readonly integrationDetector: IIntegrationDetector,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IIntegrationWebviewProvider) private readonly webviewProvider: IIntegrationWebviewProvider
    ) {}

    public activate(): void {
        // Register the manage integrations command
        // The command can optionally receive an integration ID to select/configure
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ManageIntegrations, (integrationId?: string) =>
                this.showIntegrationsUI(integrationId)
            )
        );

        // Listen for active notebook changes to update context
        this.extensionContext.subscriptions.push(
            window.onDidChangeActiveNotebookEditor(() =>
                this.updateContext().catch((err) =>
                    logger.error('IntegrationManager: Failed to update context on notebook editor change', err)
                )
            )
        );

        // Listen for notebook document changes
        this.extensionContext.subscriptions.push(
            workspace.onDidOpenNotebookDocument(() =>
                this.updateContext().catch((err) =>
                    logger.error('IntegrationManager: Failed to update context on notebook open', err)
                )
            )
        );

        this.extensionContext.subscriptions.push(
            workspace.onDidCloseNotebookDocument(() =>
                this.updateContext().catch((err) =>
                    logger.error('IntegrationManager: Failed to update context on notebook close', err)
                )
            )
        );

        // Initial context update
        this.updateContext().catch((err) =>
            logger.error('IntegrationManager: Failed to update context on activation', err)
        );
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
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     */
    private async showIntegrationsUI(selectedIntegrationId?: string): Promise<void> {
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

        // First try to detect integrations from the stored project
        let integrations = await this.integrationDetector.detectIntegrations(projectId);

        // If no integrations found in stored project, scan cells directly
        // This handles the case where the notebook was already open when the extension loaded
        if (integrations.size === 0) {
            logger.debug(`IntegrationManager: No integrations found in stored project, scanning cells directly`);
            integrations = await this.detectIntegrationsFromCells(activeNotebook);
        }

        logger.debug(`IntegrationManager: Found ${integrations.size} integrations`);

        if (integrations.size === 0) {
            void window.showInformationMessage(`No integrations found in this project.`);
            return;
        }

        // Show the webview with optional selected integration
        await this.webviewProvider.show(integrations, selectedIntegrationId);
    }

    /**
     * Detect integrations by scanning cells directly (fallback method)
     * This is used when the project isn't stored in the notebook manager
     */
    private async detectIntegrationsFromCells(notebook: NotebookDocument): Promise<Map<string, IntegrationWithStatus>> {
        // Collect all cells with SQL integration metadata
        const blocksWithIntegrations: BlockWithIntegration[] = [];

        for (const cell of notebook.getCells()) {
            const deepnoteMetadata = cell.metadata?.deepnoteMetadata;
            logger.trace(`IntegrationManager: Cell ${cell.index} metadata:`, deepnoteMetadata);

            if (deepnoteMetadata?.sql_integration_id) {
                blocksWithIntegrations.push({
                    id: `cell-${cell.index}`,
                    sql_integration_id: deepnoteMetadata.sql_integration_id
                });
            }
        }

        // Use the shared utility to scan blocks and build the status map
        return scanBlocksForIntegrations(blocksWithIntegrations, this.integrationStorage, 'IntegrationManager');
    }
}
