// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView.node';
import { logger } from '../../../platform/logging';

/**
 * Activation service for the Deepnote kernel environments view.
 * Initializes the environment manager and registers the tree view.
 */
@injectable()
export class DeepnoteEnvironmentsActivationService implements IExtensionSyncActivationService {
    constructor(
        @inject(IDeepnoteEnvironmentManager)
        private readonly environmentManager: IDeepnoteEnvironmentManager,
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
            }
        );
    }
}
