// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { QuickPickItem, window, Uri } from 'vscode';
import { logger } from '../../../platform/logging';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironment } from './deepnoteEnvironment';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';

/**
 * Handles showing environment picker UI for notebook selection
 */
@injectable()
export class DeepnoteEnvironmentPicker {
    constructor(
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager
    ) {}

    /**
     * Show a quick pick to select an environment for a notebook
     * @param notebookUri The notebook URI (for context in messages)
     * @returns Selected environment, or undefined if cancelled
     */
    public async pickEnvironment(notebookUri: Uri): Promise<DeepnoteEnvironment | undefined> {
        // Wait for environment manager to finish loading environments from storage
        await this.environmentManager.waitForInitialization();

        const environments = this.environmentManager.listEnvironments();

        if (environments.length === 0) {
            // No environments exist - prompt user to create one
            const choice = await window.showInformationMessage(
                `No environments found. Create one to use with ${getDisplayPath(notebookUri)}?`,
                'Create Environment',
                'Cancel'
            );

            if (choice === 'Create Environment') {
                // Trigger the create command
                await window.showInformationMessage(
                    'Use the "Create Environment" button in the Deepnote Environments view to create an environment.'
                );
            }

            return undefined;
        }

        // Build quick pick items
        const items: (QuickPickItem & { environment?: DeepnoteEnvironment })[] = environments.map((env) => {
            const envWithStatus = this.environmentManager.getEnvironmentWithStatus(env.id);
            const statusIcon = envWithStatus?.status === 'running' ? '$(vm-running)' : '$(vm-outline)';
            const statusText = envWithStatus?.status === 'running' ? '[Running]' : '[Stopped]';

            return {
                label: `${statusIcon} ${env.name} ${statusText}`,
                description: getDisplayPath(env.pythonInterpreter.uri),
                detail: env.packages?.length ? `Packages: ${env.packages.join(', ')}` : 'No additional packages',
                environment: env
            };
        });

        // Add "Create new" option at the end
        items.push({
            label: '$(add) Create New Environment',
            description: 'Set up a new kernel environment',
            alwaysShow: true
        });

        const selected = await window.showQuickPick(items, {
            placeHolder: `Select an environment for ${getDisplayPath(notebookUri)}`,
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            return undefined; // User cancelled
        }

        if (!selected.environment) {
            // User chose "Create new"
            await window.showInformationMessage(
                'Use the "Create Environment" button in the Deepnote Environments view to create an environment.'
            );
            return undefined;
        }

        logger.info(`Selected environment "${selected.environment.name}" for notebook ${getDisplayPath(notebookUri)}`);
        return selected.environment;
    }
}
