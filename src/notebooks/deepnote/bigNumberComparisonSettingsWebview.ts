import {
    CancellationToken,
    Disposable,
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
import {
    BigNumberComparisonSettings,
    BigNumberComparisonWebviewMessage
} from '../../platform/notebooks/deepnote/types';
import { WrappedError } from '../../platform/errors/types';
import { logger } from '../../platform/logging';

/**
 * Manages the webview panel for big number comparison settings
 */
@injectable()
export class BigNumberComparisonSettingsWebviewProvider {
    private currentPanel: WebviewPanel | undefined;
    private currentPanelId: number = 0;
    private readonly disposables: Disposable[] = [];
    private currentCell: NotebookCell | undefined;
    private resolvePromise: ((settings: BigNumberComparisonSettings | null) => void) | undefined;

    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

    /**
     * Show the big number comparison settings webview
     */
    public async show(cell: NotebookCell, token?: CancellationToken): Promise<BigNumberComparisonSettings | null> {
        this.currentCell = cell;

        const column = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;

        // If we already have a panel, cancel any outstanding operation before disposing
        if (this.currentPanel) {
            // Cancel the previous operation by resolving with null
            if (this.resolvePromise) {
                this.resolvePromise(null);
                this.resolvePromise = undefined;
            }
            // Now dispose the old panel
            this.currentPanel.dispose();
        }

        // Increment panel ID to track this specific panel instance
        this.currentPanelId++;
        const panelId = this.currentPanelId;

        // Create a new panel
        this.currentPanel = window.createWebviewPanel(
            'deepnoteBigNumberComparisonSettings',
            localize.BigNumberComparison.title,
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
            async (message: BigNumberComparisonWebviewMessage) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Handle cancellation token if provided
        let cancellationDisposable: Disposable | undefined;
        if (token) {
            cancellationDisposable = token.onCancellationRequested(() => {
                // Only handle cancellation if this is still the current panel
                if (this.currentPanelId === panelId) {
                    if (this.resolvePromise) {
                        this.resolvePromise(null);
                        this.resolvePromise = undefined;
                    }
                    this.currentPanel?.dispose();
                }
            });
        }

        // Reset when the current panel is closed
        this.currentPanel.onDidDispose(
            () => {
                // Only handle disposal if this is still the current panel
                if (this.currentPanelId === panelId) {
                    this.currentPanel = undefined;
                    this.currentCell = undefined;
                    if (this.resolvePromise) {
                        this.resolvePromise(null);
                        this.resolvePromise = undefined;
                    }
                    // Clean up cancellation listener
                    cancellationDisposable?.dispose();
                    this.disposables.forEach((d) => d.dispose());
                    this.disposables.length = 0;
                }
            },
            null,
            this.disposables
        );

        // Send initial data after a small delay to ensure webview is ready
        // This is necessary because postMessage can fail if sent before the webview is fully loaded
        setTimeout(async () => {
            await this.sendLocStrings();
            await this.sendInitialData();
        }, 100);

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

        const settings: BigNumberComparisonSettings = {
            enabled: (metadata?.deepnote_big_number_comparison_enabled as boolean) ?? false,
            comparisonType:
                (metadata?.deepnote_big_number_comparison_type as 'percentage-change' | 'absolute-value' | '') ?? '',
            comparisonValue: (metadata?.deepnote_big_number_comparison_value as string) ?? '',
            comparisonTitle: (metadata?.deepnote_big_number_comparison_title as string) ?? '',
            comparisonFormat: (metadata?.deepnote_big_number_comparison_format as string) ?? ''
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
            bigNumberComparisonTitle: localize.BigNumberComparison.title,
            enableComparison: localize.BigNumberComparison.enableComparison,
            comparisonTypeLabel: localize.BigNumberComparison.comparisonTypeLabel,
            percentageChange: localize.BigNumberComparison.percentageChange,
            absoluteValue: localize.BigNumberComparison.absoluteValue,
            comparisonValueLabel: localize.BigNumberComparison.comparisonValueLabel,
            comparisonValuePlaceholder: localize.BigNumberComparison.comparisonValuePlaceholder,
            comparisonTitleLabel: localize.BigNumberComparison.comparisonTitleLabel,
            comparisonTitlePlaceholder: localize.BigNumberComparison.comparisonTitlePlaceholder,
            comparisonFormatLabel: localize.BigNumberComparison.comparisonFormatLabel,
            comparisonFormatHelp: localize.BigNumberComparison.comparisonFormatHelp,
            saveButton: localize.BigNumberComparison.saveButton,
            cancelButton: localize.BigNumberComparison.cancelButton
        };

        await this.currentPanel.webview.postMessage({
            type: 'locInit',
            locStrings
        });
    }

    private async handleMessage(message: BigNumberComparisonWebviewMessage): Promise<void> {
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
                        // Error is already shown to user in saveSettings
                        logger.error('BigNumberComparisonSettingsWebview: Failed to save settings', error);
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

    private async saveSettings(settings: BigNumberComparisonSettings): Promise<void> {
        if (!this.currentCell) {
            return;
        }

        const edit = new WorkspaceEdit();
        const metadata = { ...(this.currentCell.metadata as Record<string, unknown>) };

        metadata.deepnote_big_number_comparison_enabled = settings.enabled;
        metadata.deepnote_big_number_comparison_type = settings.comparisonType;
        metadata.deepnote_big_number_comparison_value = settings.comparisonValue;
        metadata.deepnote_big_number_comparison_title = settings.comparisonTitle;
        metadata.deepnote_big_number_comparison_format = settings.comparisonFormat;

        // Update cell metadata
        edit.set(this.currentCell.notebook.uri, [NotebookEdit.updateCellMetadata(this.currentCell.index, metadata)]);

        try {
            const success = await workspace.applyEdit(edit);
            if (!success) {
                const errorMessage = localize.BigNumberComparison.failedToSave;
                logger.error(errorMessage);
                void window.showErrorMessage(errorMessage);
                throw new WrappedError(errorMessage, undefined);
            }
        } catch (error) {
            const errorMessage = localize.BigNumberComparison.failedToSave;
            const cause = error instanceof Error ? error : undefined;
            const causeMessage = cause?.message || String(error);
            logger.error(`${errorMessage}: ${causeMessage}`, error);
            void window.showErrorMessage(errorMessage);
            throw new WrappedError(errorMessage, cause);
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
                'bigNumberComparisonSettings',
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

        const title = localize.BigNumberComparison.title;

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
