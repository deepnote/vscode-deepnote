import { inject, injectable } from 'inversify';
import { workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IIntegrationEnvLiveRefresher, IIntegrationStorage } from './types';

/** Live-refreshes integration env in open Deepnote kernels when integration configs change (no restart). */
@injectable()
export class IntegrationEnvRefreshHandler implements IExtensionSyncActivationService {
    constructor(
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IIntegrationEnvLiveRefresher) private readonly liveRefresher: IIntegrationEnvLiveRefresher,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        logger.info('IntegrationEnvRefreshHandler: Initialized');

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
