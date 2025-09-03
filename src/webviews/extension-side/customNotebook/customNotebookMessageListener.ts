// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { IWebviewPanel, IWebviewPanelMessageListener } from '../../../platform/common/application/types';
import { CustomNotebookDocument } from './customNotebookDocument';
import { CustomNotebookMessages, CustomNotebookMapping } from './types';

export class CustomNotebookMessageListener implements IWebviewPanelMessageListener {
    private disposedCallback: () => void;
    private callback: (message: string, payload: any) => void;
    private viewChanged: (panel: IWebviewPanel) => void;

    constructor(
        private readonly document: CustomNotebookDocument,
        callback: (message: string, payload: any) => void,
        viewChanged: (panel: IWebviewPanel) => void,
        disposed: () => void
    ) {
        this.disposedCallback = disposed;
        this.callback = callback;
        this.viewChanged = viewChanged;

        // Listen for document changes and send to webview
        this.document.onDidChangeContent(e => {
            if (e.content) {
                // Need to send via callback since we don't have direct postMessage
                this.callback(CustomNotebookMessages.NotebookUpdated, e.content);
            }
        });
    }

    public dispose() {
        this.disposedCallback();
    }

    public onChangeViewState(panel: IWebviewPanel) {
        this.viewChanged(panel);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public async onMessage(message: string, payload: any): Promise<void> {
        switch (message) {
            case CustomNotebookMessages.LoadNotebook:
                await this.handleLoadNotebook();
                break;

            case CustomNotebookMessages.UpdateCell:
                await this.handleUpdateCell(payload);
                break;

            case CustomNotebookMessages.AddCell:
                await this.handleAddCell(payload);
                break;

            case CustomNotebookMessages.DeleteCell:
                await this.handleDeleteCell(payload);
                break;

            case CustomNotebookMessages.MoveCell:
                await this.handleMoveCell(payload);
                break;

            case CustomNotebookMessages.ExecuteCell:
                await this.handleExecuteCell(payload);
                break;

            case CustomNotebookMessages.Save:
                await this.handleSave();
                break;

            default:
                // Handle other messages if needed
                break;
        }
    }

    private async handleLoadNotebook(): Promise<void> {
        this.callback(CustomNotebookMessages.LoadNotebook, this.document.documentData);
    }

    private async handleUpdateCell(payload: CustomNotebookMapping[CustomNotebookMessages.UpdateCell]): Promise<void> {
        const { cellId, cell } = payload;
        this.document.updateCell(cellId, cell);
    }

    private async handleAddCell(payload: CustomNotebookMapping[CustomNotebookMessages.AddCell]): Promise<void> {
        const { cell, index } = payload;
        this.document.addCell(cell, index);
    }

    private async handleDeleteCell(payload: CustomNotebookMapping[CustomNotebookMessages.DeleteCell]): Promise<void> {
        const { cellId } = payload;
        this.document.deleteCell(cellId);
    }

    private async handleMoveCell(payload: CustomNotebookMapping[CustomNotebookMessages.MoveCell]): Promise<void> {
        const { cellId, newIndex } = payload;
        this.document.moveCell(cellId, newIndex);
    }

    private async handleExecuteCell(payload: CustomNotebookMapping[CustomNotebookMessages.ExecuteCell]): Promise<void> {
        const { cellId, code } = payload;
        console.log(`Execute cell ${cellId}:`, code);
        
        // Execute code using the kernel if available
        const executeCode = (this as any).executeCode;
        if (executeCode && typeof executeCode === 'function') {
            try {
                await executeCode(code, (output: any) => {
                    console.log(`Cell ${cellId} output:`, output);
                    // Could send output back to webview here if needed
                });
                console.log(`Cell ${cellId} executed successfully`);
            } catch (error) {
                console.error(`Failed to execute cell ${cellId}:`, error);
                // Could send error back to webview here
            }
        } else {
            console.log('No kernel available for execution, code would be:', code);
        }
    }

    private async handleSave(): Promise<void> {
        await this.document.save(undefined);
    }
}