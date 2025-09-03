// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import {
    CancellationToken,
    CustomDocumentBackup,
    CustomDocumentBackupContext,
    CustomDocumentEditEvent,
    CustomDocumentOpenContext,
    CustomEditorProvider,
    CustomReadonlyEditorProvider,
    EventEmitter,
    Uri,
    Webview,
    WebviewPanel,
    window
} from 'vscode';

import { IDisposable, IExtensionContext } from '../../../platform/common/types';
import { joinPath } from '../../../platform/vscode-path/resources';
import { IKernel, IKernelProvider } from '../../../kernels/types';
import { executeSilentlyAndEmitOutput } from '../../../kernels/helpers';
import { CustomNotebookDocument } from './customNotebookDocument';
import { CustomNotebookMessageListener } from './customNotebookMessageListener';

@injectable()
export class CustomNotebookProvider implements CustomEditorProvider<CustomNotebookDocument>, CustomReadonlyEditorProvider<CustomNotebookDocument>, IDisposable {
    private readonly _onDidChangeCustomDocument = new EventEmitter<CustomDocumentEditEvent<CustomNotebookDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private messageListener: CustomNotebookMessageListener | undefined;

    constructor(
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider
    ) {}

    /**
     * Called when our custom editor is opened.
     */
    async openCustomDocument(
        uri: Uri,
        openContext: CustomDocumentOpenContext,
        _token: CancellationToken
    ): Promise<CustomNotebookDocument> {
        const document = await CustomNotebookDocument.create(uri, openContext.backupId, {
            openCustomDocument: this.openCustomDocument.bind(this)
        });

        // Listen for changes to the document
        document.onDidChangeContent(() => {
            // Tell VS Code that the document has been edited
            this._onDidChangeCustomDocument.fire({
                document,
                undo: async () => {
                    // Implement undo logic if needed
                },
                redo: async () => {
                    // Implement redo logic if needed
                }
            });
        });

        return document;
    }

    /**
     * Called when our custom editor is opened in a webview panel.
     */
    async resolveCustomEditor(
        document: CustomNotebookDocument,
        webviewPanel: WebviewPanel,
        _token: CancellationToken
    ): Promise<void> {
        // Setup webview options
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                joinPath(this.context.extensionUri, 'dist', 'webviews'),
                joinPath(this.context.extensionUri, 'node_modules')
            ]
        };

        // Set the webview's initial html content
        await this.updateWebviewContent(webviewPanel.webview, document);

        // Setup message listener
        this.messageListener = new CustomNotebookMessageListener(
            document,
            (_message, _payload) => {
                // Handle messages from webview - not needed for this pattern
            },
            (_panel) => {
                // Handle view state changes - not needed for this pattern
            },
            () => {
                // Handle disposal
                this.messageListener = undefined;
            }
        );
        
        // Give the message listener access to execute code
        (this.messageListener as any).executeCode = this.executeCode.bind(this);

        // Listen for messages from webview
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (this.messageListener) {
                await this.messageListener.onMessage(message.command, message);
            }
        });
    }

    /**
     * Called when our custom readonly editor is opened.
     */
    async openCustomReadonlyDocument(
        uri: Uri,
        openContext: CustomDocumentOpenContext,
        _token: CancellationToken
    ): Promise<CustomNotebookDocument> {
        return this.openCustomDocument(uri, openContext, _token);
    }

    /**
     * Called when our custom readonly editor is opened in a webview panel.
     */
    async resolveCustomReadonlyEditor(
        document: CustomNotebookDocument,
        webviewPanel: WebviewPanel,
        _token: CancellationToken
    ): Promise<void> {
        return this.resolveCustomEditor(document, webviewPanel, _token);
    }

    /**
     * Called by VS Code when the user saves the document.
     */
    async saveCustomDocument(document: CustomNotebookDocument, cancellation: CancellationToken): Promise<void> {
        return await document.save(cancellation);
    }

    /**
     * Called by VS Code when the user saves the document to a new location.
     */
    async saveCustomDocumentAs(
        document: CustomNotebookDocument,
        destination: Uri,
        cancellation: CancellationToken
    ): Promise<void> {
        return await document.saveAs(destination, cancellation);
    }

    /**
     * Called by VS Code when the user calls `revert` on a document.
     */
    async revertCustomDocument(
        document: CustomNotebookDocument,
        cancellation: CancellationToken
    ): Promise<void> {
        return await document.revert(cancellation);
    }

    /**
     * Called by VS Code to backup the edited document.
     */
    async backupCustomDocument(
        document: CustomNotebookDocument,
        context: CustomDocumentBackupContext,
        cancellation: CancellationToken
    ): Promise<CustomDocumentBackup> {
        return await document.backup(context.destination, cancellation, context);
    }

    private async updateWebviewContent(webview: Webview, document: CustomNotebookDocument): Promise<void> {
        const webviewUri = webview.asWebviewUri(
            joinPath(this.context.extensionUri, 'dist', 'webviews', 'webview-side', 'customNotebook', 'customNotebook.js')
        );

        const codiconsUri = webview.asWebviewUri(
            joinPath(this.context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Custom Jupyter Notebook</title>
                <link href="${codiconsUri}" rel="stylesheet" />
                <style>
                    body {
                        padding: 0;
                        margin: 0;
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        font-weight: var(--vscode-font-weight);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    
                    #root {
                        width: 100%;
                        height: 100vh;
                    }
                </style>
            </head>
            <body>
                <div id="root"></div>
                <script>
                    window.initialNotebookData = ${JSON.stringify(document.documentData)};
                </script>
                <script src="${webviewUri}"></script>
            </body>
            </html>
        `;
    }

    /**
     * Execute Python code using the active Jupyter kernel
     */
    public async executeCode(code: string, onOutput?: (output: any) => void): Promise<void> {
        // For now, we'll get the kernel from the active notebook editor
        // In a full implementation, you might want to manage kernel per custom notebook
        const activeNotebook = window.activeNotebookEditor?.notebook;
        let kernel: IKernel | undefined;

        if (activeNotebook) {
            kernel = this.kernelProvider.get(activeNotebook);
        }

        if (!kernel || !kernel.session?.kernel) {
            throw new Error('No active Jupyter kernel found. Please open a regular Jupyter notebook first to start a kernel.');
        }

        return new Promise((resolve, reject) => {
            const kernelConnection = kernel!.session!.kernel!;
            let hasStarted = false;
            
            executeSilentlyAndEmitOutput(
                kernelConnection,
                code,
                () => {
                    hasStarted = true;
                    console.log('Code execution started');
                },
                (output) => {
                    console.log('Code execution output:', output);
                    if (onOutput) {
                        onOutput(output);
                    }
                }
            );

            // The executeSilentlyAndEmitOutput doesn't return a promise, 
            // so we'll resolve immediately after starting
            if (hasStarted) {
                resolve();
            } else {
                // Fallback: resolve after a short delay if execution started
                setTimeout(() => {
                    if (hasStarted) {
                        resolve();
                    } else {
                        reject(new Error('Code execution failed to start'));
                    }
                }, 1000);
            }
        });
    }

    dispose(): void {
        this._onDidChangeCustomDocument.dispose();
        if (this.messageListener) {
            this.messageListener.dispose();
            this.messageListener = undefined;
        }
    }
}