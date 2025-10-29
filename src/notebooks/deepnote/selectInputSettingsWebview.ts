// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
    Disposable,
    l10n,
    NotebookCell,
    NotebookEdit,
    Uri,
    ViewColumn,
    WebviewPanel,
    window,
    workspace,
    WorkspaceEdit
} from 'vscode';
import { inject, injectable } from 'inversify';
import { IExtensionContext } from '../../platform/common/types';
import { LocalizedMessages } from '../../messageTypes';
import * as localize from '../../platform/common/utils/localize';
import { SelectInputSettings, SelectInputWebviewMessage } from '../../platform/notebooks/deepnote/types';
import { WrappedError } from '../../platform/errors/types';
import { logger } from '../../platform/logging';

/**
 * Manages the webview panel for select input settings
 */
@injectable()
export class SelectInputSettingsWebviewProvider {
    private currentPanel: WebviewPanel | undefined;
    private readonly disposables: Disposable[] = [];
    private currentCell: NotebookCell | undefined;
    private resolvePromise: ((settings: SelectInputSettings | null) => void) | undefined;

    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

    /**
     * Show the select input settings webview
     */
    public async show(cell: NotebookCell): Promise<SelectInputSettings | null> {
        this.currentCell = cell;

        const column = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;

        // If we already have a panel, dispose it and create a new one
        if (this.currentPanel) {
            this.currentPanel.dispose();
        }

        // Create a new panel
        this.currentPanel = window.createWebviewPanel(
            'deepnoteSelectInputSettings',
            localize.SelectInputSettings.title,
            column || ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionContext.extensionUri]
            }
        );

        // Set the webview's initial html content
        this.currentPanel.webview.html = this.getWebviewContent();

        // Handle messages from the webview
        this.currentPanel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Reset when the current panel is closed
        this.currentPanel.onDidDispose(
            () => {
                this.currentPanel = undefined;
                this.currentCell = undefined;
                if (this.resolvePromise) {
                    this.resolvePromise(null);
                    this.resolvePromise = undefined;
                }
                this.disposables.forEach((d) => d.dispose());
                this.disposables.length = 0;
            },
            null,
            this.disposables
        );

        // Send initial data
        await this.sendLocStrings();
        await this.sendInitialData();

        // Return a promise that resolves when the user saves or cancels
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    }

    private async sendInitialData(): Promise<void> {
        if (!this.currentPanel || !this.currentCell) {
            return;
        }

        const metadata = this.currentCell.metadata as Record<string, unknown> | undefined;

        const settings: SelectInputSettings = {
            allowMultipleValues: (metadata?.deepnote_allow_multiple_values as boolean) ?? false,
            allowEmptyValue: (metadata?.deepnote_allow_empty_values as boolean) ?? false,
            selectType: (metadata?.deepnote_variable_select_type as 'from-options' | 'from-variable') ?? 'from-options',
            options: (metadata?.deepnote_variable_custom_options as string[]) ?? [],
            selectedVariable: (metadata?.deepnote_variable_selected_variable as string) ?? ''
        };

        await this.currentPanel.webview.postMessage({
            type: 'init',
            settings
        });
    }

    private async sendLocStrings(): Promise<void> {
        if (!this.currentPanel) {
            return;
        }

        const locStrings: Partial<LocalizedMessages> = {
            selectInputSettingsTitle: localize.SelectInputSettings.title,
            allowMultipleValues: localize.SelectInputSettings.allowMultipleValues,
            allowEmptyValue: localize.SelectInputSettings.allowEmptyValue,
            valueSourceTitle: localize.SelectInputSettings.valueSourceTitle,
            fromOptions: localize.SelectInputSettings.fromOptions,
            fromOptionsDescription: localize.SelectInputSettings.fromOptionsDescription,
            addOptionPlaceholder: localize.SelectInputSettings.addOptionPlaceholder,
            addButton: localize.SelectInputSettings.addButton,
            fromVariable: localize.SelectInputSettings.fromVariable,
            fromVariableDescription: localize.SelectInputSettings.fromVariableDescription,
            variablePlaceholder: localize.SelectInputSettings.variablePlaceholder,
            optionNameLabel: localize.SelectInputSettings.optionNameLabel,
            variableNameLabel: localize.SelectInputSettings.variableNameLabel,
            removeOptionAriaLabel: localize.SelectInputSettings.removeOptionAriaLabel,
            saveButton: localize.SelectInputSettings.saveButton,
            cancelButton: localize.SelectInputSettings.cancelButton
        };

        await this.currentPanel.webview.postMessage({
            type: 'locInit',
            locStrings
        });
    }

    private async handleMessage(message: SelectInputWebviewMessage): Promise<void> {
        switch (message.type) {
            case 'save':
                if (this.currentCell) {
                    try {
                        await this.saveSettings(message.settings);
                        if (this.resolvePromise) {
                            this.resolvePromise(message.settings);
                            this.resolvePromise = undefined;
                        }
                        this.currentPanel?.dispose();
                    } catch (error) {
                        // Error is already shown to user in saveSettings, just reject the promise
                        if (this.resolvePromise) {
                            this.resolvePromise(null);
                            this.resolvePromise = undefined;
                        }
                        // Keep panel open so user can retry or cancel
                    }
                }
                break;

            case 'cancel':
                if (this.resolvePromise) {
                    this.resolvePromise(null);
                    this.resolvePromise = undefined;
                }
                this.currentPanel?.dispose();
                break;

            case 'init':
            case 'locInit':
                // These messages are sent from extension to webview, not handled here
                break;
        }
    }

    private async saveSettings(settings: SelectInputSettings): Promise<void> {
        if (!this.currentCell) {
            return;
        }

        const edit = new WorkspaceEdit();
        const metadata = { ...(this.currentCell.metadata as Record<string, unknown>) };

        metadata.deepnote_allow_multiple_values = settings.allowMultipleValues;
        metadata.deepnote_allow_empty_values = settings.allowEmptyValue;
        metadata.deepnote_variable_select_type = settings.selectType;
        metadata.deepnote_variable_custom_options = settings.options;
        metadata.deepnote_variable_selected_variable = settings.selectedVariable;

        // Update the options field based on the select type
        if (settings.selectType === 'from-options') {
            metadata.deepnote_variable_options = settings.options;
        } else {
            // Clear stale options when not using 'from-options' mode
            delete metadata.deepnote_variable_options;
        }

        // Update cell metadata to preserve outputs and attachments
        edit.set(this.currentCell.notebook.uri, [NotebookEdit.updateCellMetadata(this.currentCell.index, metadata)]);

        const success = await workspace.applyEdit(edit);
        if (!success) {
            const errorMessage = l10n.t('Failed to save select input settings');
            logger.error(errorMessage);
            void window.showErrorMessage(errorMessage);
            throw new WrappedError(errorMessage, undefined);
        }
    }

    private getWebviewContent(): string {
        if (!this.currentPanel) {
            return '';
        }

        const webview = this.currentPanel.webview;
        const nonce = this.getNonce();

        // Get URIs for the React app
        const scriptUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'selectInputSettings',
                'index.js'
            )
        );
        const codiconUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'react-common',
                'codicon',
                'codicon.css'
            )
        );

        const title = localize.SelectInputSettings.title;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link rel="stylesheet" href="${codiconUri}">
    <title>${title}</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose(): void {
        this.currentPanel?.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}
