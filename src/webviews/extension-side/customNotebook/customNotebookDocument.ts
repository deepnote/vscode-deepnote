// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { 
    CustomDocument, 
    CustomDocumentBackup, 
    CustomDocumentBackupContext, 
    CustomDocumentOpenContext, 
    EventEmitter, 
    Uri 
} from 'vscode';
import { CustomNotebookData, CustomNotebookCell } from './types';
import { generateUuid } from '../../../platform/common/uuid';

export class CustomNotebookDocument implements CustomDocument {
    static async create(uri: Uri, backupId: string | undefined, _delegate: { 
        openCustomDocument: (uri: Uri, openContext: CustomDocumentOpenContext, token: any) => Thenable<CustomDocument>;
    }): Promise<CustomNotebookDocument> {
        const dataFile = typeof backupId === 'string' ? Uri.parse(backupId) : uri;
        const fileData = await CustomNotebookDocument.readFile(dataFile);
        return new CustomNotebookDocument(uri, fileData);
    }

    private static async readFile(uri: Uri): Promise<CustomNotebookData> {
        const fs = await import('fs');
        try {
            const content = fs.readFileSync(uri.fsPath, 'utf8');
            const data = JSON.parse(content) as CustomNotebookData;
            
            // Ensure cells have IDs
            data.cells.forEach(cell => {
                if (!cell.metadata.cell_id) {
                    cell.metadata.cell_id = generateUuid();
                }
            });

            // Provide defaults for required fields
            return {
                ...data,
                nbformat: data.nbformat || 4,
                nbformat_minor: data.nbformat_minor || 4,
                metadata: data.metadata || {},
                cells: data.cells || []
            };
        } catch (error) {
            // Return empty notebook if file doesn't exist or is invalid
            return {
                cells: [],
                metadata: {
                    kernelspec: {
                        display_name: 'Python 3',
                        language: 'python',
                        name: 'python3'
                    },
                    language_info: {
                        name: 'python'
                    }
                },
                nbformat: 4,
                nbformat_minor: 4
            };
        }
    }

    private readonly _uri: Uri;
    private _documentData: CustomNotebookData;
    private readonly _onDidChangeDocument = new EventEmitter<{
        readonly content?: CustomNotebookData;
        readonly edits: readonly any[];
    }>();
    private readonly _onDidChange = new EventEmitter<{
        readonly label: string;
        undo(): void;
        redo(): void;
    }>();

    public readonly onDidChangeContent = this._onDidChangeDocument.event;
    public readonly onDidChange = this._onDidChange.event;

    private constructor(uri: Uri, initialContent: CustomNotebookData) {
        this._uri = uri;
        this._documentData = initialContent;
    }

    public get uri() { return this._uri; }

    public get documentData(): CustomNotebookData {
        return this._documentData;
    }

    dispose(): void {
        this._onDidChangeDocument.dispose();
        this._onDidChange.dispose();
    }

    /**
     * Called by VS Code when the user saves the document.
     */
    async save(_cancellation: any): Promise<void> {
        await this.saveAs(this._uri, _cancellation);
    }

    /**
     * Called by VS Code when the user saves the document to a new location.
     */
    async saveAs(targetResource: Uri, _cancellation: any): Promise<void> {
        const fs = await import('fs');
        const content = JSON.stringify(this._documentData, null, 2);
        fs.writeFileSync(targetResource.fsPath, content, 'utf8');
    }

    /**
     * Called by VS Code when the user calls `revert` on a document.
     */
    async revert(_cancellation: any): Promise<void> {
        const diskContent = await CustomNotebookDocument.readFile(this._uri);
        this._documentData = diskContent;
        this._onDidChangeDocument.fire({
            content: diskContent,
            edits: []
        });
    }

    /**
     * Called by VS Code to backup the edited document.
     */
    async backup(destination: Uri, _cancellation: any, _context: CustomDocumentBackupContext): Promise<CustomDocumentBackup> {
        await this.saveAs(destination, _cancellation);
        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    const fs = await import('fs');
                    fs.unlinkSync(destination.fsPath);
                } catch {
                    // ignore
                }
            }
        };
    }

    /**
     * Update the document's data.
     */
    updateDocumentData(data: CustomNotebookData): void {
        this._documentData = data;
        this._onDidChangeDocument.fire({
            content: data,
            edits: []
        });
    }

    /**
     * Update a specific cell in the document.
     */
    updateCell(cellId: string, updates: Partial<CustomNotebookCell>): void {
        const cellIndex = this._documentData.cells.findIndex(cell => cell.metadata.cell_id === cellId);
        if (cellIndex >= 0) {
            const cell = this._documentData.cells[cellIndex];
            this._documentData.cells[cellIndex] = { ...cell, ...updates };
            this._onDidChangeDocument.fire({
                content: this._documentData,
                edits: []
            });
        }
    }

    /**
     * Add a new cell to the document.
     */
    addCell(cell: CustomNotebookCell, index?: number): void {
        if (!cell.metadata.cell_id) {
            cell.metadata.cell_id = generateUuid();
        }

        if (typeof index === 'number' && index >= 0 && index <= this._documentData.cells.length) {
            this._documentData.cells.splice(index, 0, cell);
        } else {
            this._documentData.cells.push(cell);
        }

        this._onDidChangeDocument.fire({
            content: this._documentData,
            edits: []
        });
    }

    /**
     * Delete a cell from the document.
     */
    deleteCell(cellId: string): void {
        const cellIndex = this._documentData.cells.findIndex(cell => cell.metadata.cell_id === cellId);
        if (cellIndex >= 0) {
            this._documentData.cells.splice(cellIndex, 1);
            this._onDidChangeDocument.fire({
                content: this._documentData,
                edits: []
            });
        }
    }

    /**
     * Move a cell to a new position.
     */
    moveCell(cellId: string, newIndex: number): void {
        const cellIndex = this._documentData.cells.findIndex(cell => cell.metadata.cell_id === cellId);
        if (cellIndex >= 0 && newIndex >= 0 && newIndex < this._documentData.cells.length) {
            const [cell] = this._documentData.cells.splice(cellIndex, 1);
            this._documentData.cells.splice(newIndex, 0, cell);
            this._onDidChangeDocument.fire({
                content: this._documentData,
                edits: []
            });
        }
    }
}