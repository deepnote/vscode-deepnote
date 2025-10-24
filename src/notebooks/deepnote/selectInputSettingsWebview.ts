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
import { SelectInputSettings } from '../../webviews/webview-side/selectInputSettings/types';

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
            l10n.t('Select Input Settings'),
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
        await this.sendInitialData();
        await this.sendLocStrings();

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
            saveButton: localize.SelectInputSettings.saveButton,
            cancelButton: localize.SelectInputSettings.cancelButton
        };

        await this.currentPanel.webview.postMessage({
            type: 'locInit',
            locStrings
        });
    }

    private async handleMessage(message: { type: string; settings?: SelectInputSettings }): Promise<void> {
        switch (message.type) {
            case 'save':
                if (message.settings && this.currentCell) {
                    await this.saveSettings(message.settings);
                    if (this.resolvePromise) {
                        this.resolvePromise(message.settings);
                        this.resolvePromise = undefined;
                    }
                    this.currentPanel?.dispose();
                }
                break;

            case 'cancel':
                if (this.resolvePromise) {
                    this.resolvePromise(null);
                    this.resolvePromise = undefined;
                }
                this.currentPanel?.dispose();
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
        }

        // Update cell metadata to preserve outputs and attachments
        edit.set(this.currentCell.notebook.uri, [NotebookEdit.updateCellMetadata(this.currentCell.index, metadata)]);

        await workspace.applyEdit(edit);
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

        const title = l10n.t('Select Input Settings');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
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
