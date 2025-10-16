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
        // Note: When invoked from a notebook cell status bar, VSCode passes context object first,
        // then the actual arguments from the command definition
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ManageIntegrations, (...args: unknown[]) => {
                logger.debug(`IntegrationManager: Command invoked with args:`, args);

                // Find the integration ID from the arguments
                // It could be the first arg (if called directly) or in the args array (if called from UI)
                let integrationId: string | undefined;

                for (const arg of args) {
                    if (typeof arg === 'string') {
                        integrationId = arg;
                        break;
                    }
                }

                logger.debug(`IntegrationManager: Extracted integrationId: ${integrationId}`);
                return this.showIntegrationsUI(integrationId);
            })
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

        // If a specific integration was requested (e.g., from status bar click),
        // ensure it's in the map even if not detected from the project
        if (selectedIntegrationId && !integrations.has(selectedIntegrationId)) {
            logger.debug(`IntegrationManager: Adding requested integration ${selectedIntegrationId} to the map`);
            const config = await this.integrationStorage.get(selectedIntegrationId);
            integrations.set(selectedIntegrationId, {
                config: config || null,
                status: config ? IntegrationStatus.Connected : IntegrationStatus.Disconnected
            });
        }

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
            const metadata = cell.metadata;
            logger.trace(`IntegrationManager: Cell ${cell.index} metadata:`, metadata);

            // Check cell metadata for sql_integration_id
            if (metadata && typeof metadata === 'object') {
                const integrationId = (metadata as Record<string, unknown>).sql_integration_id;
                if (typeof integrationId === 'string') {
                    logger.debug(`IntegrationManager: Found integration ${integrationId} in cell ${cell.index}`);
                    blocksWithIntegrations.push({
                        id: `cell-${cell.index}`,
                        sql_integration_id: integrationId
                    });
                }
            }
        }

        logger.debug(`IntegrationManager: Found ${blocksWithIntegrations.length} cells with integrations`);

        // Use the shared utility to scan blocks and build the status map
        return scanBlocksForIntegrations(blocksWithIntegrations, this.integrationStorage, 'IntegrationManager');
    }
}
