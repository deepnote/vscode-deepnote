import { inject, injectable } from 'inversify';
import { workspace, CancellationToken, window } from 'vscode';
import * as fs from 'fs';
import * as path from '../../platform/vscode-path/path';
import type { DeepnoteProject } from './deepnoteTypes';
import { ILogger } from '../../platform/logging/types';
import { IPersistentStateFactory } from '../../platform/common/types';

const DONT_ASK_OVERWRITE_REQUIREMENTS_KEY = 'DEEPNOTE_DONT_ASK_OVERWRITE_REQUIREMENTS';

/**
 * Helper class for creating requirements.txt files from Deepnote project settings.
 */
@injectable()
export class DeepnoteRequirementsHelper {
    constructor(
        @inject(ILogger) private readonly logger: ILogger,
        @inject(IPersistentStateFactory) private readonly persistentStateFactory: IPersistentStateFactory
    ) {}

    /**
     * Extracts requirements from project settings and creates a local requirements.txt file.
     * @param project The Deepnote project data containing requirements in settings
     * @param token Cancellation token to abort the operation if needed
     */
    async createRequirementsFile(project: DeepnoteProject, token: CancellationToken): Promise<void> {
        try {
            // Check if the operation has been cancelled
            if (token.isCancellationRequested) {
                return;
            }

            const requirements = project.project.settings?.requirements;
            if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
                this.logger.info(`No requirements found in project ${project.project.id}`);
                return;
            }

            // Get the workspace folder to determine where to create the requirements.txt file
            const workspaceFolders = workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                this.logger.info('No workspace folder found, cannot create requirements.txt');
                return;
            }

            // Check cancellation before performing I/O
            if (token.isCancellationRequested) {
                return;
            }

            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const requirementsPath = path.join(workspaceRoot, 'requirements.txt');

            // Convert requirements array to text format first
            const requirementsText = requirements.join('\n') + '\n';

            // Check if requirements.txt already exists
            const fileExists = await fs.promises
                .access(requirementsPath)
                .then(() => true)
                .catch(() => false);

            if (fileExists) {
                // Read existing file contents and compare
                const existingContent = await fs.promises.readFile(requirementsPath, 'utf8');

                if (existingContent === requirementsText) {
                    this.logger.info('requirements.txt already has the correct content, skipping update');
                    return;
                }

                // File exists but content is different, check if we should prompt user
                const dontAskState = this.persistentStateFactory.createGlobalPersistentState<boolean>(
                    DONT_ASK_OVERWRITE_REQUIREMENTS_KEY,
                    false // default: ask user
                );

                if (!dontAskState.value) {
                    // User hasn't chosen "Don't Ask Again", so prompt them
                    const yes = 'Yes';
                    const no = 'No';
                    const dontAskAgain = "Don't Ask Again";

                    const response = await window.showWarningMessage(
                        `A requirements.txt file already exists in this workspace. Do you want to override it with requirements from your Deepnote project?`,
                        { modal: true },
                        yes,
                        no,
                        dontAskAgain
                    );

                    // Check cancellation after showing the prompt
                    if (token.isCancellationRequested) {
                        return;
                    }

                    switch (response) {
                        case yes:
                            // User wants to override, continue with writing
                            this.logger.info('User chose to override requirements.txt');
                            break;
                        case no:
                            // User doesn't want to override
                            this.logger.info('User chose not to override requirements.txt');
                            return;
                        case dontAskAgain:
                            // User chose "Don't Ask Again", save preference and override this time
                            await dontAskState.updateValue(true);
                            this.logger.info('User chose "Don\'t Ask Again" for requirements.txt override');
                            break;
                        default:
                            // User dismissed the prompt (clicked X)
                            this.logger.info('User dismissed requirements.txt override prompt');
                            return;
                    }
                } else {
                    // User previously selected "Don't Ask Again", automatically override
                    this.logger.info(
                        'Automatically overriding requirements.txt (user previously selected "Don\'t Ask Again")'
                    );
                }
            }

            // Write the requirements.txt file
            await fs.promises.writeFile(requirementsPath, requirementsText, 'utf8');

            // Check cancellation after I/O operation
            if (token.isCancellationRequested) {
                this.logger.info('Requirements file creation was cancelled after write');
                return;
            }

            this.logger.info(
                `Created requirements.txt with ${requirements.length} dependencies at ${requirementsPath}`
            );
        } catch (error) {
            this.logger.error(`Error creating requirements.txt:`, error);
        }
    }
}

export const IDeepnoteRequirementsHelper = Symbol('IDeepnoteRequirementsHelper');
export interface IDeepnoteRequirementsHelper {
    createRequirementsFile(project: DeepnoteProject, token: CancellationToken): Promise<void>;
}
