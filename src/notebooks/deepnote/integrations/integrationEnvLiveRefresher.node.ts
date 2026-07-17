import { inject, injectable } from 'inversify';
import { l10n, type NotebookDocument, window } from 'vscode';

import { IKernelProvider } from '../../../kernels/types';
import { logger } from '../../../platform/logging';
import { IIntegrationEnvLiveRefresher } from './types';

/** `_dntk` isn't guaranteed here, so import the package to re-fetch + apply integration env in the kernel. */
const REFRESH_INTEGRATION_ENV_SNIPPET = `import deepnote_toolkit
deepnote_toolkit.set_integration_env()`;

@injectable()
export class IntegrationEnvLiveRefresher implements IIntegrationEnvLiveRefresher {
    constructor(@inject(IKernelProvider) private readonly kernelProvider: IKernelProvider) {}

    public async refresh(notebooks: readonly NotebookDocument[]): Promise<void> {
        const results = await Promise.all(notebooks.map((notebook) => this.refreshNotebook(notebook)));
        const refreshedCount = results.filter(Boolean).length;

        if (refreshedCount > 0) {
            void window.showInformationMessage(l10n.t('Deepnote integration environment updated.'));
        }
    }

    /** Refreshes one kernel; never throws (per-notebook errors are logged), resolves true only on a clean run. */
    private async refreshNotebook(notebook: NotebookDocument): Promise<boolean> {
        try {
            const kernel = this.kernelProvider.get(notebook);
            if (!kernel || !kernel.startedAtLeastOnce) {
                return false;
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

                return false;
            }

            return true;
        } catch (err) {
            logger.error(
                `IntegrationEnvLiveRefresher: Failed to refresh integration env for ${notebook.uri.toString()}`,
                err
            );

            return false;
        }
    }
}
