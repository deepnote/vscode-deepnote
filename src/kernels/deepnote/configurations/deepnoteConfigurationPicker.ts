// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { QuickPickItem, window, Uri } from 'vscode';
import { logger } from '../../../platform/logging';
import { IDeepnoteConfigurationManager } from '../types';
import { DeepnoteKernelConfiguration } from './deepnoteKernelConfiguration';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';

/**
 * Handles showing configuration picker UI for notebook selection
 */
@injectable()
export class DeepnoteConfigurationPicker {
    constructor(
        @inject(IDeepnoteConfigurationManager) private readonly configurationManager: IDeepnoteConfigurationManager
    ) {}

    /**
     * Show a quick pick to select a kernel configuration for a notebook
     * @param notebookUri The notebook URI (for context in messages)
     * @returns Selected configuration, or undefined if cancelled
     */
    public async pickConfiguration(notebookUri: Uri): Promise<DeepnoteKernelConfiguration | undefined> {
        const configurations = this.configurationManager.listConfigurations();

        if (configurations.length === 0) {
            // No configurations exist - prompt user to create one
            const choice = await window.showInformationMessage(
                `No kernel configurations found. Create one to use with ${getDisplayPath(notebookUri)}?`,
                'Create Configuration',
                'Cancel'
            );

            if (choice === 'Create Configuration') {
                // Trigger the create command
                await window.showInformationMessage(
                    'Use the "Create Kernel Configuration" button in the Deepnote Kernel Configurations view to create a configuration.'
                );
            }

            return undefined;
        }

        // Build quick pick items
        const items: (QuickPickItem & { configuration?: DeepnoteKernelConfiguration })[] = configurations.map(
            (config) => {
                const configWithStatus = this.configurationManager.getConfigurationWithStatus(config.id);
                const statusIcon = configWithStatus?.status === 'running' ? '$(vm-running)' : '$(vm-outline)';
                const statusText = configWithStatus?.status === 'running' ? '[Running]' : '[Stopped]';

                return {
                    label: `${statusIcon} ${config.name} ${statusText}`,
                    description: getDisplayPath(config.pythonInterpreter.uri),
                    detail: config.packages?.length
                        ? `Packages: ${config.packages.join(', ')}`
                        : 'No additional packages',
                    configuration: config
                };
            }
        );

        // Add "Create new" option at the end
        items.push({
            label: '$(add) Create New Configuration',
            description: 'Set up a new kernel environment',
            alwaysShow: true
        });

        const selected = await window.showQuickPick(items, {
            placeHolder: `Select a kernel configuration for ${getDisplayPath(notebookUri)}`,
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            return undefined; // User cancelled
        }

        if (!selected.configuration) {
            // User chose "Create new"
            await window.showInformationMessage(
                'Use the "Create Kernel Configuration" button in the Deepnote Kernel Configurations view to create a configuration.'
            );
            return undefined;
        }

        logger.info(
            `Selected configuration "${selected.configuration.name}" for notebook ${getDisplayPath(notebookUri)}`
        );
        return selected.configuration;
    }
}
