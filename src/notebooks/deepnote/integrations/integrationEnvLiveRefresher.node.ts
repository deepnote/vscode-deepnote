import { inject, injectable } from 'inversify';
import { l10n, type NotebookDocument, window } from 'vscode';

import { IKernelProvider } from '../../../kernels/types';
import { ITelemetryService } from '../../../platform/analytics/types';
import { logger } from '../../../platform/logging';
import { IIntegrationEnvLiveRefresher, type IntegrationEnvRefreshTrigger } from './types';

/** `_dntk` isn't guaranteed here, so import the package to re-fetch + apply integration env in the kernel. */
const REFRESH_INTEGRATION_ENV_SNIPPET = `import deepnote_toolkit
deepnote_toolkit.set_integration_env()`;

/** How long the transient "environment updated" status-bar message stays visible. */
const STATUS_BAR_MESSAGE_TIMEOUT_MS = 5000;

/** Per-notebook result. `'skipped'` is not a failure: the notebook simply had no kernel to refresh. */
type RefreshResult = 'refreshed' | 'skipped' | 'snippet_error' | 'execution_failed';

@injectable()
export class IntegrationEnvLiveRefresher implements IIntegrationEnvLiveRefresher {
    constructor(
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(ITelemetryService) private readonly analytics: ITelemetryService
    ) {}

    public async refresh(notebooks: readonly NotebookDocument[], trigger: IntegrationEnvRefreshTrigger): Promise<void> {
        const results = await Promise.all(notebooks.map((notebook) => this.refreshNotebook(notebook)));
        const refreshedCount = results.filter((result) => result === 'refreshed').length;
        const failures = results.filter(
            (result): result is 'execution_failed' | 'snippet_error' =>
                result === 'snippet_error' || result === 'execution_failed'
        );

        if (refreshedCount > 0) {
            // Transient status-bar message rather than a persistent toast, so frequent env-file edits don't spam notifications.
            window.setStatusBarMessage(
                l10n.t('Deepnote integration environment updated.'),
                STATUS_BAR_MESSAGE_TIMEOUT_MS
            );
        }

        // A pass where every notebook was skipped says nothing about whether the refresh works, and would turn
        // this into a per-file-save emitter for anyone editing with no kernel running.
        if (refreshedCount === 0 && failures.length === 0) {
            return;
        }

        this.analytics.trackEvent({
            eventName: 'refresh_integration_env',
            properties: {
                attemptedCount: notebooks.length,
                failedCount: failures.length,
                refreshedCount,
                trigger,
                ...(failures.length > 0 ? { failureKind: failures[0] } : {})
            }
        });
    }

    /** Refreshes one kernel; never throws (per-notebook errors are logged) and reports how it went. */
    private async refreshNotebook(notebook: NotebookDocument): Promise<RefreshResult> {
        try {
            const kernel = this.kernelProvider.get(notebook);
            if (!kernel || !kernel.startedAtLeastOnce) {
                return 'skipped';
            }

            const outputs = await this.kernelProvider
                .getKernelExecution(kernel)
                .executeHidden(REFRESH_INTEGRATION_ENV_SNIPPET);

            const errors = outputs.filter((output) => output.output_type === 'error');
            if (errors.length > 0) {
                logger.warn(
                    `IntegrationEnvLiveRefresher: Refresh snippet produced errors for ${notebook.uri.toString()}`,
                    errors
                );

                return 'snippet_error';
            }

            return 'refreshed';
        } catch (err) {
            logger.error(
                `IntegrationEnvLiveRefresher: Failed to refresh integration env for ${notebook.uri.toString()}`,
                err
            );

            return 'execution_failed';
        }
    }
}
