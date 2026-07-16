import { inject, injectable } from 'inversify';
import { l10n, type NotebookDocument, window } from 'vscode';

import { IKernelProvider } from '../../../kernels/types';
import { logger } from '../../../platform/logging';
import { IIntegrationEnvLiveRefresher } from './types';

/**
 * Toolkit snippet re-fetches integration env from the local endpoint and live-sets it into the kernel process.
 * The `_dntk` alias is not guaranteed here, so import the package explicitly.
 */
const REFRESH_INTEGRATION_ENV_SNIPPET = `import deepnote_toolkit
deepnote_toolkit.set_integration_env()`;

/**
 * Refreshes integration environment variables inside already-started kernels without restarting them by running the
 * Deepnote toolkit's `set_integration_env()` silently in each kernel.
 */
@injectable()
export class IntegrationEnvLiveRefresher implements IIntegrationEnvLiveRefresher {
    constructor(@inject(IKernelProvider) private readonly kernelProvider: IKernelProvider) {}

    public async refresh(notebooks: readonly NotebookDocument[]): Promise<void> {
        let refreshedCount = 0;

        for (const notebook of notebooks) {
            try {
                const kernel = this.kernelProvider.get(notebook);
                if (!kernel || !kernel.startedAtLeastOnce) {
                    continue;
                }

                const outputs = await this.kernelProvider
                    .getKernelExecution(kernel)
                    .executeHidden(REFRESH_INTEGRATION_ENV_SNIPPET);

                const errors = outputs.filter((output) => output.output_type === 'error');
                if (errors.length > 0) {
                    // The env was not (fully) applied, so don't claim success in the notification.
                    logger.warn(
                        `IntegrationEnvLiveRefresher: Refresh snippet produced errors for ${notebook.uri.toString()}`,
                        errors
                    );

                    continue;
                }

                refreshedCount += 1;
            } catch (err) {
                logger.error(
                    `IntegrationEnvLiveRefresher: Failed to refresh integration env for ${notebook.uri.toString()}`,
                    err
                );
            }
        }

        if (refreshedCount > 0) {
            void window.showInformationMessage(l10n.t('Deepnote integration environment updated.'));
        }
    }
}
