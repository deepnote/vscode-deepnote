// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { QuickPickItem, window, Uri, commands, ThemeColor } from 'vscode';
import { logger } from '../../../platform/logging';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironment, EnvironmentStatus } from './deepnoteEnvironment';
import { getDisplayPath } from '../../../platform/common/platform/fs-paths';

export function getDeepnoteEnvironmentStatusVisual(status: EnvironmentStatus): {
    icon: string;
    text: string;
    themeColor: ThemeColor;
    contextValue: string;
} {
    switch (status) {
        case EnvironmentStatus.Running:
            return {
                icon: 'vm-running',
                text: 'Running',
                contextValue: 'deepnoteEnvironment.running',
                themeColor: { id: 'charts.green' }
            };
        case EnvironmentStatus.Starting:
            return {
                icon: 'vm-outline',
                text: 'Starting',
                contextValue: 'deepnoteEnvironment.starting',
                themeColor: { id: 'charts.yellow' }
            };
        case EnvironmentStatus.Stopped:
            return {
                icon: 'vm-outline',
                text: 'Stopped',
                contextValue: 'deepnoteEnvironment.stopped',
                themeColor: { id: 'charts.gray' }
            };
        case EnvironmentStatus.Error:
            return {
                icon: 'vm-outline',
                text: 'Error',
                contextValue: 'deepnoteEnvironment.stopped',
                themeColor: { id: 'charts.gray' }
            };
        default:
            status satisfies never;
            return {
                icon: 'vm-outline',
                text: 'Unknown',
                contextValue: 'deepnoteEnvironment.stopped',
                themeColor: { id: 'charts.gray' }
            };
    }
}

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
                logger.info('Triggering create environment command from picker');
                await commands.executeCommand('deepnote.environments.create');

                // Check if an environment was created
                const newEnvironments = this.environmentManager.listEnvironments();
                if (newEnvironments.length > 0) {
                    // Environment created, show picker again
                    logger.info('Environment created, showing picker again');
                    return this.pickEnvironment(notebookUri);
                }
            }

            return undefined;
        }

        // Build quick pick items
        const items: (QuickPickItem & { environment?: DeepnoteEnvironment })[] = environments.map((env) => {
            const envWithStatus = this.environmentManager.getEnvironmentWithStatus(env.id);
            const { icon, text } = getDeepnoteEnvironmentStatusVisual(
                envWithStatus?.status || EnvironmentStatus.Stopped
            );

            return {
                label: `$(${icon}) ${env.name} [${text}]`,
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
            // User chose "Create new" - execute the create command and retry
            logger.info('User chose to create new environment - triggering create command');
            await commands.executeCommand('deepnote.environments.create');

            // After creation, refresh the list and show picker again
            const newEnvironments = this.environmentManager.listEnvironments();
            if (newEnvironments.length > environments.length) {
                // A new environment was created, show the picker again
                logger.info('Environment created, showing picker again');
                return this.pickEnvironment(notebookUri);
            }

            // User cancelled creation
            logger.info('No new environment created');
            return undefined;
        }

        logger.info(`Selected environment "${selected.environment.name}" for notebook ${getDisplayPath(notebookUri)}`);
        return selected.environment;
    }
}
