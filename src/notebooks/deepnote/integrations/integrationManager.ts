import { inject, injectable, optional } from 'inversify';
import { commands, l10n, NotebookDocument, ProgressLocation, QuickPickItem, window, workspace } from 'vscode';

import { CommandOutcome, ITelemetryService } from '../../../platform/analytics/types';
import { isCancellationError } from '../../../platform/common/cancellation';
import { IExtensionContext } from '../../../platform/common/types';
import { Commands } from '../../../platform/common/constants';
import * as localize from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import {
    IIntegrationDetector,
    IIntegrationEnvLiveRefresher,
    IIntegrationManager,
    IIntegrationStorage,
    IIntegrationWebviewProvider
} from './types';
import { IDeepnoteNotebookManager, RawProjectIntegration } from '../../types';
import { DatabaseIntegrationType, databaseIntegrationTypes } from '@deepnote/database-integrations';
import {
    attachExistingIntegration,
    collectReusableIntegrations,
    CollectReusableIntegrationsResult,
    ReusableIntegration
} from './existingIntegrationPicker';
import { isSnapshotFile } from '../snapshots/snapshotFiles';

interface ReusableIntegrationQuickPickItem extends QuickPickItem {
    integration: ReusableIntegration;
}

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
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(ITelemetryService) private readonly analytics: ITelemetryService,
        // Node-only service: the web extension has no kernels to refresh.
        @inject(IIntegrationEnvLiveRefresher)
        @optional()
        private readonly liveRefresher?: IIntegrationEnvLiveRefresher
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

        // Accepts the same argument shapes as ManageIntegrations so the panel and menus can pass a notebook URI.
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.AddExistingIntegration, (...args: unknown[]) => {
                let notebookUri: string | undefined;

                for (const arg of args) {
                    notebookUri ??= this.extractNotebookUri(arg);
                }

                return this.addExistingIntegration(notebookUri);
            })
        );
    }

    /**
     * Offers the integrations other projects in the workspace declare and links the chosen one into this project;
     * no credentials are copied (see `collectReusableIntegrations`). Public so tests can drive it without
     * `commands.executeCommand`.
     */
    public async addExistingIntegration(notebookUri?: string): Promise<CommandOutcome> {
        const activeNotebook = this.resolveDeepnoteNotebook(notebookUri);

        if (!activeNotebook) {
            void window.showErrorMessage(l10n.t('No active Deepnote notebook'));

            return 'failed';
        }

        // The panel keeps sending the URI it was opened for, so a closed notebook must not fall back to another project.
        if (notebookUri && activeNotebook.uri.toString() !== notebookUri) {
            void window.showErrorMessage(localize.Integrations.addExistingIntegrationNotebookClosed);

            return 'failed';
        }

        // `*.snapshot.deepnote` matches the notebook selector, so this command can run against a focused snapshot.
        // The writer skips snapshots, which would report a failure only after the cache had already been updated.
        if (isSnapshotFile(activeNotebook.uri)) {
            void window.showErrorMessage(localize.Integrations.addExistingIntegrationSnapshotUnsupported);

            return 'failed';
        }

        const projectId = activeNotebook.metadata?.deepnoteProjectId;
        const notebookId = activeNotebook.metadata?.deepnoteNotebookId;

        if (!projectId || !notebookId) {
            void window.showErrorMessage(l10n.t('Cannot determine project or notebook ID'));

            return 'failed';
        }

        const currentIntegrations = this.getCachedProjectIntegrations(projectId, notebookId);

        if (!currentIntegrations) {
            void window.showErrorMessage(localize.Integrations.addExistingIntegrationFailed);

            return 'failed';
        }

        let scan: CollectReusableIntegrationsResult;

        try {
            scan = await window.withProgress(
                {
                    cancellable: true,
                    location: ProgressLocation.Notification,
                    title: localize.Integrations.addExistingIntegrationScanning
                },
                (_progress, token) =>
                    collectReusableIntegrations({
                        excludeIntegrationIds: new Set(currentIntegrations.map((entry) => entry.id)),
                        integrationStorage: this.integrationStorage,
                        projectId,
                        token
                    })
            );
        } catch (error) {
            if (error instanceof Error && isCancellationError(error)) {
                return 'cancelled';
            }

            throw error;
        }

        const { conflictingIds, integrations } = scan;

        if (conflictingIds.length > 0) {
            void window.showWarningMessage(
                localize.Integrations.addExistingIntegrationConflictsSkipped(conflictingIds.length)
            );
        }

        if (integrations.length === 0) {
            void window.showInformationMessage(localize.Integrations.addExistingIntegrationNoneAvailable);

            return 'completed';
        }

        const items: ReusableIntegrationQuickPickItem[] = integrations.map((integration) => ({
            description: localize.Integrations.typeLabel(integration.type),
            detail: localize.Integrations.addExistingIntegrationUsedIn(integration.projectNames.join(', ')),
            integration,
            label: integration.name
        }));

        const picked = await window.showQuickPick(items, {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: localize.Integrations.addExistingIntegrationPlaceholder
        });

        if (!picked) {
            return 'cancelled';
        }

        const { integration } = picked;

        let outcome: CommandOutcome = 'failed';

        try {
            const { activePersisted, siblingsFailed } = await attachExistingIntegration({
                activeFileUri: activeNotebook.uri,
                integration,
                notebookManager: this.notebookManager,
                projectId
            });

            if (activePersisted) {
                outcome = 'completed';
                void window.showInformationMessage(
                    localize.Integrations.addExistingIntegrationSucceeded(integration.name)
                );

                if (siblingsFailed > 0) {
                    void window.showWarningMessage(
                        l10n.t(
                            'Integrations saved, but {0} related notebook file(s) could not be updated.',
                            siblingsFailed
                        )
                    );
                }

                // Storage did not change, so the storage-change listeners that normally refresh kernels and the
                // panel after a save stay silent; do both explicitly for this project.
                await this.refreshAfterProjectIntegrationsChange(projectId, activeNotebook);
            } else {
                void window.showErrorMessage(localize.Integrations.addExistingIntegrationFailed);
            }
        } catch (error) {
            logger.error(`IntegrationManager: failed to add existing integration ${integration.id}`, error);
            void window.showErrorMessage(localize.Integrations.addExistingIntegrationFailed);
        }

        this.analytics.trackEvent({
            eventName: 'add_existing_integration',
            properties: { integrationType: integration.type, outcome }
        });

        return outcome;
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

    /** The integrations the project declares, or `undefined` when it is not cached at all. */
    private getCachedProjectIntegrations(projectId: string, notebookId: string): RawProjectIntegration[] | undefined {
        const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);

        return project ? [...(project.project.integrations ?? [])] : undefined;
    }

    private async refreshAfterProjectIntegrationsChange(
        projectId: string,
        activeNotebook: NotebookDocument
    ): Promise<void> {
        const projectNotebooks = workspace.notebookDocuments.filter(
            (notebook) => notebook.notebookType === 'deepnote' && notebook.metadata?.deepnoteProjectId === projectId
        );

        try {
            await this.liveRefresher?.refresh(projectNotebooks, 'integration_config');
        } catch (error) {
            logger.error('IntegrationManager: failed to refresh integration env after adding an integration', error);
        }

        try {
            await this.showIntegrationsUI(undefined, activeNotebook.uri.toString());
        } catch (error) {
            logger.error('IntegrationManager: failed to refresh the integrations panel', error);
        }
    }

    /**
     * The Deepnote notebook to act on: `window.activeNotebookEditor` is unset until an editor is focused, so a
     * restored but not yet focused notebook resolves via the menu's URI or the one visible editor instead.
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
            notebookId,
            notebookUri: activeNotebook.uri,
            projectId
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
