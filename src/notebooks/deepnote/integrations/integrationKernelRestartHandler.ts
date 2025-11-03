import { inject, injectable } from 'inversify';
import { l10n, NotebookDocument, workspace, window } from 'vscode';

import { IDisposableRegistry } from '../../../platform/common/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { logger } from '../../../platform/logging';
import { IIntegrationStorage } from './types';
import { IKernelProvider } from '../../../kernels/types';
import { DATAFRAME_SQL_INTEGRATION_ID } from '../../../platform/notebooks/deepnote/integrationTypes';

/**
 * Handles automatic kernel restart when integration configurations change.
 * When a user saves/deletes an integration config, this service restarts all kernels
 * that are using that integration so they pick up the new credentials.
 */
@injectable()
export class IntegrationKernelRestartHandler implements IExtensionSyncActivationService {
    private isRestarting = false;

    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        logger.info('IntegrationKernelRestartHandler: Initialized');

        // Listen for integration configuration changes
        disposables.push(
            this.integrationStorage.onDidChangeIntegrations(() => {
                this.onIntegrationConfigurationChanged().catch((err) =>
                    logger.error('IntegrationKernelRestartHandler: Failed to handle integration change', err)
                );
            })
        );
    }

    public activate(): void {
        // Service is activated via constructor
    }

    /**
     * Handle integration configuration changes by restarting affected kernels
     */
    private async onIntegrationConfigurationChanged(): Promise<void> {
        // Prevent multiple simultaneous restart attempts
        if (this.isRestarting) {
            logger.debug('IntegrationKernelRestartHandler: Already restarting, skipping');
            return;
        }

        try {
            this.isRestarting = true;

            logger.info(
                'IntegrationKernelRestartHandler: Integration configuration changed, checking for affected kernels'
            );

            // Find all Deepnote notebooks with running kernels that use SQL integrations
            const notebooksToRestart: NotebookDocument[] = [];

            for (const notebook of workspace.notebookDocuments) {
                // Only process Deepnote notebooks
                if (notebook.notebookType !== 'deepnote') {
                    continue;
                }

                // Check if kernel is running
                const kernel = this.kernelProvider.get(notebook);
                if (!kernel || !kernel.startedAtLeastOnce) {
                    continue;
                }

                // Check if notebook uses SQL integrations
                const usesIntegrations = this.notebookUsesSqlIntegrations(notebook);
                if (usesIntegrations) {
                    notebooksToRestart.push(notebook);
                }
            }

            if (notebooksToRestart.length === 0) {
                logger.info(
                    'IntegrationKernelRestartHandler: No running kernels use SQL integrations, no restart needed'
                );
                return;
            }

            logger.info(
                `IntegrationKernelRestartHandler: Found ${notebooksToRestart.length} notebook(s) with kernels that need restart`
            );

            // Restart kernels for affected notebooks
            const restartPromises = notebooksToRestart.map(async (notebook) => {
                const kernel = this.kernelProvider.get(notebook);
                if (kernel) {
                    try {
                        logger.info(
                            `IntegrationKernelRestartHandler: Restarting kernel for notebook: ${notebook.uri.toString()}`
                        );
                        await kernel.restart();
                        logger.info(
                            `IntegrationKernelRestartHandler: Successfully restarted kernel for: ${notebook.uri.toString()}`
                        );
                    } catch (error) {
                        logger.error(
                            `IntegrationKernelRestartHandler: Failed to restart kernel for ${notebook.uri.toString()}`,
                            error
                        );
                        // Don't throw - we want to continue restarting other kernels
                    }
                }
            });

            await Promise.all(restartPromises);

            // Show a notification to the user
            if (notebooksToRestart.length === 1) {
                void window.showInformationMessage(
                    l10n.t('Integration configuration updated. Kernel restarted to apply changes.')
                );
            } else {
                void window.showInformationMessage(
                    l10n.t(
                        'Integration configuration updated. {0} kernels restarted to apply changes.',
                        notebooksToRestart.length
                    )
                );
            }
        } finally {
            this.isRestarting = false;
        }
    }

    /**
     * Check if a notebook uses SQL integrations by scanning cells for sql_integration_id metadata
     */
    private notebookUsesSqlIntegrations(notebook: NotebookDocument): boolean {
        for (const cell of notebook.getCells()) {
            // Check for SQL cells
            if (cell.document.languageId !== 'sql') {
                continue;
            }

            const metadata = cell.metadata;
            if (metadata && typeof metadata === 'object') {
                const integrationId = (metadata as Record<string, unknown>).sql_integration_id;
                if (typeof integrationId === 'string' && integrationId !== DATAFRAME_SQL_INTEGRATION_ID) {
                    // Found a SQL cell with an external integration
                    return true;
                }
            }
        }

        return false;
    }
}
