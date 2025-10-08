// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { workspace } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DeepnoteProject } from './deepnoteTypes';

/**
 * Helper class for creating requirements.txt files from Deepnote project settings.
 */
export class DeepnoteRequirementsHelper {
    /**
     * Extracts requirements from project settings and creates a local requirements.txt file.
     * @param project The Deepnote project data containing requirements in settings
     */
    static async createRequirementsFile(project: DeepnoteProject): Promise<void> {
        try {
            const requirements = project.project.settings?.requirements;
            if (!requirements || !Array.isArray(requirements) || requirements.length === 0) {
                console.log(`No requirements found in project ${project.project.id}`);
                return;
            }

            // Get the workspace folder to determine where to create the requirements.txt file
            const workspaceFolders = workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                console.log('No workspace folder found, cannot create requirements.txt');
                return;
            }

            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const requirementsPath = path.join(workspaceRoot, 'requirements.txt');

            // Convert requirements array to text format
            const requirementsText = requirements.join('\n') + '\n';

            // Write the requirements.txt file
            await fs.promises.writeFile(requirementsPath, requirementsText, 'utf8');
            console.log(`Created requirements.txt with ${requirements.length} dependencies at ${requirementsPath}`);
        } catch (error) {
            console.error(`Error creating requirements.txt:`, error);
        }
    }
}
