// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDeepnoteConfigurationManager } from '../types';
import { DeepnoteConfigurationsView } from './deepnoteConfigurationsView';
import { logger } from '../../../platform/logging';

/**
 * Activation service for the Deepnote kernel configurations view.
 * Initializes the configuration manager and registers the tree view.
 */
@injectable()
export class DeepnoteConfigurationsActivationService implements IExtensionSyncActivationService {
    constructor(
        @inject(IDeepnoteConfigurationManager)
        private readonly configurationManager: IDeepnoteConfigurationManager,
        @inject(DeepnoteConfigurationsView)
        _configurationsView: DeepnoteConfigurationsView
    ) {
        // _configurationsView is injected to ensure the view is created,
        // but we don't need to store a reference to it
    }

    public activate(): void {
        logger.info('Activating Deepnote kernel configurations view');

        // Initialize the configuration manager (loads configurations from storage)
        this.configurationManager.initialize().then(
            () => {
                logger.info('Deepnote kernel configurations initialized');
            },
            (error) => {
                logger.error(`Failed to initialize Deepnote kernel configurations: ${error}`);
            }
        );
    }
}
