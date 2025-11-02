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
import { initImport, uploadFile, getErrorMessage, MAX_FILE_SIZE, getDeepnoteDomain } from './importClient.node';

@injectable()
export class OpenInDeepnoteHandler implements IExtensionSyncActivationService {
    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.OpenInDeepnote, () => this.handleOpenInDeepnote())
        );
    }

    private async handleOpenInDeepnote(): Promise<void> {
        try {
            let fileUri: Uri | undefined;
            let isNotebook = false;

            const activeNotebookEditor = window.activeNotebookEditor;
            if (activeNotebookEditor) {
                const notebook = activeNotebookEditor.notebook;
                if (notebook.notebookType === 'deepnote') {
                    fileUri = notebook.uri.with({ query: '', fragment: '' });
                    isNotebook = true;
                }
            }

            if (!fileUri) {
                const activeEditor = window.activeTextEditor;
                if (!activeEditor) {
                    void window.showErrorMessage('Please open a .deepnote file first');
                    return;
                }

                fileUri = activeEditor.document.uri;
            }

            if (!fileUri.fsPath.endsWith('.deepnote')) {
                void window.showErrorMessage('This command only works with .deepnote files');
                return;
            }

            if (isNotebook) {
                await commands.executeCommand('workbench.action.files.save');
            } else {
                const activeEditor = window.activeTextEditor;
                if (activeEditor && activeEditor.document.isDirty) {
                    const saved = await activeEditor.document.save();
                    if (!saved) {
                        void window.showErrorMessage('Please save the file before opening in Deepnote');
                        return;
                    }
                }
            }

            const filePath = fileUri.fsPath;
            const fileName = path.basename(filePath);

            logger.info(`Opening in Deepnote: ${fileName}`);

            const stats = await fs.promises.stat(filePath);
            if (stats.size > MAX_FILE_SIZE) {
                void window.showErrorMessage(`File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
                return;
            }

            const fileBuffer = await fs.promises.readFile(filePath);

            await window.withProgress(
                {
                    location: { viewId: 'workbench.view.extension.deepnoteExplorer' },
                    title: l10n.t('Opening in Deepnote'),
                    cancellable: false
                },
                async (progress) => {
                    try {
                        progress.report({ message: l10n.t('Preparing upload...') });
                        logger.debug(`Initializing import for ${fileName} (${stats.size} bytes)`);

                        const initResponse = await initImport(fileName, stats.size);
                        logger.debug(`Import initialized: ${initResponse.importId}`);

                        progress.report({ message: l10n.t('Uploading file...') });
                        await uploadFile(initResponse.uploadUrl, fileBuffer, (uploadProgress) => {
                            progress.report({
                                message: l10n.t('Uploading file... {0}%', uploadProgress.toString())
                            });
                        });
                        logger.debug('File uploaded successfully');

                        progress.report({ message: l10n.t('Opening in Deepnote...') });
                        const domain = getDeepnoteDomain();
                        const deepnoteUrl = `https://${domain}/launch?importId=${initResponse.importId}`;
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
