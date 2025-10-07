import { inject, injectable } from 'inversify';
import { commands, window, workspace } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { IDeepnoteNotebookManager } from '../../types';
import { IIntegrationDetector, IIntegrationStorage } from './types';
import { IntegrationStatus } from './integrationTypes';

/**
 * Manages integration UI and commands for Deepnote notebooks
 */
@injectable()
export class IntegrationManager {
    private hasIntegrationsContext = 'deepnote.hasIntegrations';

    private hasUnconfiguredIntegrationsContext = 'deepnote.hasUnconfiguredIntegrations';

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IIntegrationDetector) private readonly integrationDetector: IIntegrationDetector,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage
    ) {}

    public activate(): void {
        // Register the manage integrations command
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.ManageIntegrations, () => this.showIntegrationsUI())
        );

        // Listen for active notebook changes to update context
        this.extensionContext.subscriptions.push(
            window.onDidChangeActiveNotebookEditor(() => this.updateContext())
        );

        // Listen for notebook document changes
        this.extensionContext.subscriptions.push(workspace.onDidOpenNotebookDocument(() => this.updateContext()));

        this.extensionContext.subscriptions.push(workspace.onDidCloseNotebookDocument(() => this.updateContext()));

        // Initial context update
        this.updateContext();
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
            window.showErrorMessage('No active Deepnote notebook');
            return;
        }

        const projectId = activeNotebook.metadata?.deepnoteProjectId;
        if (!projectId) {
            window.showErrorMessage('Cannot determine project ID');
            return;
        }

        // Detect integrations in the project
        const integrations = await this.integrationDetector.detectIntegrations(projectId);

        if (integrations.size === 0) {
            window.showInformationMessage('No integrations found in this project');
            return;
        }

        // For now, show a simple quick pick to select an integration to configure
        // TODO: Replace with a proper webview UI
        const items = Array.from(integrations.entries()).map(([id, integration]) => ({
            label: integration.config?.name || id,
            description: integration.config?.type || 'Unknown type',
            detail:
                integration.status === IntegrationStatus.Connected
                    ? '$(check) Connected'
                    : '$(warning) Not configured',
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
     * Show configuration UI for a specific integration
     */
    private async configureIntegration(integrationId: string, integrationType?: string): Promise<void> {
        // For now, show a simple input box
        // TODO: Replace with proper configuration forms
        const name = await window.showInputBox({
            prompt: `Enter a name for this ${integrationType || 'integration'}`,
            placeHolder: 'My Integration'
        });

        if (!name) {
            return;
        }

        window.showInformationMessage(
            `Integration configuration UI will be implemented in the next step. Integration: ${integrationId}, Name: ${name}`
        );

        // Update context after configuration
        await this.updateContext();
    }
}

