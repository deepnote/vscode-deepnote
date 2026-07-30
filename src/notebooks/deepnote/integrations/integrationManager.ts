import { inject, injectable } from 'inversify';
import { commands, l10n, NotebookDocument, window, workspace } from 'vscode';

import { IExtensionContext } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import { logger } from '../../../platform/logging';
import { IIntegrationDetector, IIntegrationManager, IIntegrationStorage, IIntegrationWebviewProvider } from './types';
import { IDeepnoteNotebookManager } from '../../types';
import { DatabaseIntegrationType, databaseIntegrationTypes } from '@deepnote/database-integrations';

/**
 * Manages integration UI and commands for Deepnote notebooks
 */
@injectable()
export class IntegrationManager implements IIntegrationManager {
    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationDetector) private readonly integrationDetector: IIntegrationDetector,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IIntegrationWebviewProvider) private readonly webviewProvider: IIntegrationWebviewProvider,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager
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
                let notebookUri: string | undefined;

                for (const arg of args) {
                    if (typeof arg === 'string') {
                        integrationId ??= arg;
                        continue;
                    }
                    notebookUri ??= this.extractNotebookUri(arg);
                }

                logger.debug(`IntegrationManager: Extracted integrationId: ${integrationId}, notebook: ${notebookUri}`);

                return this.showIntegrationsUI(integrationId, notebookUri);
            })
        );
    }

    /** The notebook URI a menu contribution passed; `notebook/toolbar` sends `{ notebookEditor: { notebookUri } }`. */
    private extractNotebookUri(arg: unknown): string | undefined {
        if (!arg || typeof arg !== 'object') {
            return undefined;
        }

        const candidate = arg as { notebookUri?: unknown; notebookEditor?: { notebookUri?: unknown } };
        const uri = candidate.notebookEditor?.notebookUri ?? candidate.notebookUri;

        return uri ? String(uri) : undefined;
    }

    /**
     * The Deepnote notebook to act on: `window.activeNotebookEditor` is unset until an editor is focused, so a
     * restored-but-unclicked notebook resolves via the menu's URI or the one visible editor instead.
     */
    private resolveDeepnoteNotebook(notebookUri: string | undefined): NotebookDocument | undefined {
        if (notebookUri) {
            const fromUri = workspace.notebookDocuments.find(
                (notebook) => notebook.notebookType === 'deepnote' && notebook.uri.toString() === notebookUri
            );
            if (fromUri) {
                return fromUri;
            }
        }

        const active = window.activeNotebookEditor?.notebook;
        if (active?.notebookType === 'deepnote') {
            return active;
        }

        // Only when unambiguous: several visible Deepnote editors give no basis for a guess.
        const visible = window.visibleNotebookEditors
            .map((editor) => editor.notebook)
            .filter((notebook) => notebook.notebookType === 'deepnote');

        return visible.length === 1 ? visible[0] : undefined;
    }

    /**
     * Show the integrations management UI
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     * @param notebookUri Optional notebook URI passed by the invoking menu contribution
     */
    private async showIntegrationsUI(selectedIntegrationId?: string, notebookUri?: string): Promise<void> {
        const activeNotebook = this.resolveDeepnoteNotebook(notebookUri);

        if (!activeNotebook) {
            void window.showErrorMessage(l10n.t('No active Deepnote notebook'));
            return;
        }

        const projectId = activeNotebook.metadata?.deepnoteProjectId;
        const notebookId = activeNotebook.metadata?.deepnoteNotebookId;
        if (!projectId || !notebookId) {
            void window.showErrorMessage(l10n.t('Cannot determine project or notebook ID'));
            return;
        }

        logger.debug(`IntegrationManager: Project ID: ${projectId}`);
        logger.trace(`IntegrationManager: Notebook metadata:`, activeNotebook.metadata);

        // First try to detect integrations from the stored project
        let integrations = await this.integrationDetector.detectIntegrations({
            projectId,
            notebookId
        });
        logger.debug(`IntegrationManager: Found ${integrations.size} integrations`);

        // If a specific integration was requested (e.g., from status bar click),
        // ensure it's in the map even if not detected from the project
        if (selectedIntegrationId && !integrations.has(selectedIntegrationId)) {
            logger.debug(`IntegrationManager: Adding requested integration ${selectedIntegrationId} to the map`);
            const config = await this.integrationStorage.getIntegrationConfig(selectedIntegrationId);

            // Try to get integration metadata from the project
            const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);
            const projectIntegration = project?.project.integrations?.find((i) => i.id === selectedIntegrationId);

            let integrationName: string | undefined;
            let integrationType: DatabaseIntegrationType | undefined;

            // Validate that projectIntegration.type against supported types
            if (
                projectIntegration &&
                (databaseIntegrationTypes as readonly string[]).includes(projectIntegration.type)
            ) {
                integrationName = projectIntegration.name;
                integrationType = projectIntegration.type as DatabaseIntegrationType;
            }

            if (integrationType === 'pandas-dataframe') {
                logger.debug(`IntegrationManager: Skipping internal DuckDB integration ${selectedIntegrationId}`);
            } else {
                integrations.set(selectedIntegrationId, {
                    config: config || null,
                    integrationName,
                    integrationType
                });
            }
        }

        // Show the webview with optional selected integration
        await this.webviewProvider.show(
            projectId,
            integrations,
            activeNotebook.uri,
            selectedIntegrationId,
            activeNotebook.metadata?.deepnoteProjectName
        );
    }
}
