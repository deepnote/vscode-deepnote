// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { commands, window, Uri, env, l10n } from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IExtensionContext } from '../../platform/common/types';
import { Commands } from '../../platform/common/constants';
import { logger } from '../../platform/logging';
import * as fs from 'fs';
import * as path from '../../platform/vscode-path/path';
import { initImport, uploadFile, getErrorMessage, MAX_FILE_SIZE } from './importClient.node';

/**
 * Handler for the "Open in Deepnote" command
 * Uploads .deepnote files to Deepnote and opens them in the web app
 */
@injectable()
export class OpenInDeepnoteHandler implements IExtensionSyncActivationService {
    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

    /**
     * Activates the handler by registering the command
     */
    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.OpenInDeepnote, () => this.handleOpenInDeepnote())
        );
    }

    /**
     * Main handler for the Open in Deepnote command
     */
    private async handleOpenInDeepnote(): Promise<void> {
        try {
            // Get the active editor
            const activeEditor = window.activeTextEditor;
            if (!activeEditor) {
                void window.showErrorMessage('Please open a .deepnote file first');
                return;
            }

            const fileUri = activeEditor.document.uri;

            // Validate that it's a .deepnote file
            if (!fileUri.fsPath.endsWith('.deepnote')) {
                void window.showErrorMessage('This command only works with .deepnote files');
                return;
            }

            // Ensure the file is saved
            if (activeEditor.document.isDirty) {
                const saved = await activeEditor.document.save();
                if (!saved) {
                    void window.showErrorMessage('Please save the file before opening in Deepnote');
                    return;
                }
            }

            // Read the file
            const filePath = fileUri.fsPath;
            const fileName = path.basename(filePath);

            logger.info(`Opening in Deepnote: ${fileName}`);

            // Check file size
            const stats = await fs.promises.stat(filePath);
            if (stats.size > MAX_FILE_SIZE) {
                void window.showErrorMessage(`File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
                return;
            }

            // Read file into buffer
            const fileBuffer = await fs.promises.readFile(filePath);

            // Show progress
            await window.withProgress(
                {
                    location: { viewId: 'workbench.view.extension.deepnoteExplorer' },
                    title: l10n.t('Opening in Deepnote'),
                    cancellable: false
                },
                async (progress) => {
                    try {
                        // Step 1: Initialize import
                        progress.report({ message: l10n.t('Preparing upload...') });
                        logger.debug(`Initializing import for ${fileName} (${stats.size} bytes)`);

                        const initResponse = await initImport(fileName, stats.size);
                        logger.debug(`Import initialized: ${initResponse.importId}`);

                        // Step 2: Upload file
                        progress.report({ message: l10n.t('Uploading file...') });
                        await uploadFile(initResponse.uploadUrl, fileBuffer, (uploadProgress) => {
                            progress.report({
                                message: l10n.t('Uploading file... {0}%', uploadProgress.toString())
                            });
                        });
                        logger.debug('File uploaded successfully');

                        // Step 3: Open in browser
                        progress.report({ message: l10n.t('Opening in Deepnote...') });
                        const deepnoteUrl = `https://deepnote.com/import?id=${initResponse.importId}`;
                        await env.openExternal(Uri.parse(deepnoteUrl));

                        void window.showInformationMessage('Opening in Deepnote...');
                        logger.info('Successfully opened file in Deepnote');
                    } catch (error) {
                        logger.error('Failed to open in Deepnote', error);
                        const errorMessage = getErrorMessage(error);
                        void window.showErrorMessage(`Failed to open in Deepnote: ${errorMessage}`);
                    }
                }
            );
        } catch (error) {
            logger.error('Error in handleOpenInDeepnote', error);
            const errorMessage = getErrorMessage(error);
            void window.showErrorMessage(`Failed to open in Deepnote: ${errorMessage}`);
        }
    }
}
