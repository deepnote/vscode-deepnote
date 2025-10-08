// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { workspace, CancellationToken } from 'vscode';
import * as fs from 'fs';
import * as path from '../../platform/vscode-path/path';
import type { DeepnoteProject } from './deepnoteTypes';
import { ILogger } from '../../platform/logging/types';

/**
 * Helper class for creating requirements.txt files from Deepnote project settings.
 */
@injectable()
export class DeepnoteRequirementsHelper {
    constructor(@inject(ILogger) private readonly logger: ILogger) {}

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

            const requirements = project.project.settings.requirements;
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

            // Convert requirements array to text format
            const requirementsText = requirements.join('\n') + '\n';

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
