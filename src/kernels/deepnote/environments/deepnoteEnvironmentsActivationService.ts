// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView.node';
import { logger } from '../../../platform/logging';
import { IOutputChannel } from '../../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../../platform/common/constants';
import { l10n } from 'vscode';

/**
 * Activation service for the Deepnote kernel environments view.
 * Initializes the environment manager and registers the tree view.
 */
@injectable()
export class DeepnoteEnvironmentsActivationService implements IExtensionSyncActivationService {
    constructor(
        @inject(IDeepnoteEnvironmentManager)
        private readonly environmentManager: IDeepnoteEnvironmentManager,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(DeepnoteEnvironmentsView)
        _environmentsView: DeepnoteEnvironmentsView
    ) {
        // _environmentsView is injected to ensure the view is created,
        // but we don't need to store a reference to it
    }

    public activate(): void {
        logger.info('Activating Deepnote kernel environments view');

        // Initialize the environment manager (loads environments from storage)
        this.environmentManager.initialize().then(
            () => {
                logger.info('Deepnote kernel environments initialized');
            },
            (error: unknown) => {
                logger.error('Failed to initialize Deepnote kernel environments', error);
                const msg = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(l10n.t('Failed to initialize Deepnote kernel environments: {0}', msg));
            }
        );
    }
}
