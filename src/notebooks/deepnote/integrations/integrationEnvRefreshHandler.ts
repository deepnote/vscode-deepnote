import { inject, injectable } from 'inversify';
import { workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IIntegrationEnvLiveRefresher, IIntegrationStorage } from './types';

/**
 * Live-refreshes integration environment variables in open Deepnote kernels when integration
 * configurations change. When a user saves/deletes an integration config, this re-runs the Deepnote
 * toolkit's `set_integration_env()` in each notebook's kernel so it picks up the new credentials
 * without a restart.
 */
@injectable()
export class IntegrationEnvRefreshHandler implements IExtensionSyncActivationService {
    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IIntegrationEnvLiveRefresher) private readonly liveRefresher: IIntegrationEnvLiveRefresher,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        logger.info('IntegrationEnvRefreshHandler: Initialized');

        // Listen for integration configuration changes
        disposables.push(
            this.integrationStorage.onDidChangeIntegrations(() => {
                this.onIntegrationConfigurationChanged().catch((err) =>
                    logger.error('IntegrationEnvRefreshHandler: Failed to handle integration change', err)
                );
            })
        );
    }

    public activate(): void {
        // Service is activated via constructor
    }

    private async onIntegrationConfigurationChanged(): Promise<void> {
        const notebooks = workspace.notebookDocuments.filter(
            (notebook) => notebook.notebookType === DEEPNOTE_NOTEBOOK_TYPE
        );

        await this.liveRefresher.refresh(notebooks);
    }
}
