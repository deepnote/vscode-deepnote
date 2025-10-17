import { inject, injectable } from 'inversify';
import { workspace, CancellationToken, window, Uri, l10n } from 'vscode';
import * as fs from 'fs';

import type { DeepnoteProject } from './deepnoteTypes';
import { ILogger } from '../../platform/logging/types';
import { IPersistentStateFactory } from '../../platform/common/types';

const DONT_ASK_OVERWRITE_REQUIREMENTS_KEY = 'DEEPNOTE_DONT_ASK_OVERWRITE_REQUIREMENTS';

export const IDeepnoteRequirementsHelper = Symbol('IDeepnoteRequirementsHelper');
export interface IDeepnoteRequirementsHelper {
    createRequirementsFile(project: DeepnoteProject, token: CancellationToken): Promise<void>;
}

/**
 * Helper class for creating requirements.txt files from Deepnote project settings.
 */
@injectable()
export class DeepnoteRequirementsHelper implements IDeepnoteRequirementsHelper {
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

            // Validate and normalize requirements: ensure they are valid strings, trim them, remove empty entries, and dedupe
            const normalizedRequirements = Array.from(
                new Set(
                    requirements
                        .filter((req): req is string => typeof req === 'string') // Keep only string entries with type guard
                        .map((req) => req.trim()) // Trim whitespace
                        .filter((req) => req.length > 0) // Remove empty strings
                )
            );

            if (normalizedRequirements.length === 0) {
                this.logger.info(`No valid requirements found in project ${project.project.id}`);
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

            // Use Uri.joinPath to build the filesystem path using the Uri API
            const requirementsPath = Uri.joinPath(workspaceFolders[0].uri, 'requirements.txt').fsPath;

            // Convert normalized requirements array to text format (using LF line endings)
            const requirementsText = normalizedRequirements.join('\n') + '\n';

            // Helper to normalize line endings to LF for comparison
            const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n');

            // Check if requirements.txt already exists
            const fileExists = await fs.promises
                .access(requirementsPath)
                .then(() => true)
                .catch(() => false);

            if (fileExists) {
                // Read existing file contents and compare (normalize line endings for comparison)
                const existingContent = await fs.promises.readFile(requirementsPath, 'utf8');
                const normalizedExistingContent = normalizeLineEndings(existingContent);
                const normalizedRequirementsText = normalizeLineEndings(requirementsText);

                if (normalizedExistingContent === normalizedRequirementsText) {
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
                    const yes = l10n.t('Yes');
                    const no = l10n.t('No');
                    const dontAskAgain = l10n.t("Don't Ask Again");

                    const response = await window.showWarningMessage(
                        l10n.t(
                            'A requirements.txt file already exists in this workspace. Do you want to override it with requirements from your Deepnote project?'
                        ),
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
                `Created requirements.txt with ${normalizedRequirements.length} dependencies at ${requirementsPath}`
            );
        } catch (error) {
            this.logger.error(`Error creating requirements.txt:`, error);
        }
    }
}
