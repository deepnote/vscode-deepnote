// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable, inject } from 'inversify';
import { commands, window, NotebookCellData, NotebookCellKind, NotebookEdit, NotebookRange } from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { Commands } from '../../platform/common/constants';
import { noop } from '../../platform/common/utils/misc';
import { chainWithPendingUpdates } from '../../kernels/execution/notebookUpdater';
import { DeepnoteBigNumberMetadataSchema } from './deepnoteSchemas';

/**
 * Service responsible for registering and handling Deepnote-specific notebook commands.
 */
@injectable()
export class DeepnoteNotebookCommandListener implements IExtensionSyncActivationService {
    constructor(@inject(IDisposableRegistry) private readonly disposableRegistry: IDisposableRegistry) {}

    /**
     * Activates the service by registering Deepnote-specific commands.
     */
    public activate(): void {
        this.registerCommands();
    }

    private registerCommands(): void {
        this.disposableRegistry.push(commands.registerCommand(Commands.AddSqlBlock, () => this.addSqlBlock()));
        this.disposableRegistry.push(
            commands.registerCommand(Commands.AddBigNumberChartBlock, () => this.addBigNumberChartBlock())
        );
    }

    private addSqlBlock(): void {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            return;
        }
        const document = editor.notebook;
        const selection = editor.selection;

        // Determine the index where to insert the new cell (below current selection or at the end)
        const insertIndex = selection ? selection.end : document.cellCount;

        chainWithPendingUpdates(document, (edit) => {
            // Create a SQL cell with SQL language for syntax highlighting
            // This matches the SqlBlockConverter representation
            const newCell = new NotebookCellData(NotebookCellKind.Code, '', 'sql');
            newCell.metadata = {
                __deepnotePocket: {
                    type: 'sql'
                }
            };
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        }).then(() => {
            editor.selection = new NotebookRange(insertIndex, insertIndex + 1);
        }, noop);
    }

    private addBigNumberChartBlock(): void {
        const editor = window.activeNotebookEditor;
        if (!editor) {
            return;
        }
        const document = editor.notebook;
        const selection = editor.selection;

        // Determine the index where to insert the new cell (below current selection or at the end)
        const insertIndex = selection ? selection.end : document.cellCount;

        // Initialize empty metadata from the zod schema
        const bigNumberMetadata = DeepnoteBigNumberMetadataSchema.parse({});

        const metadata = {
            __deepnotePocket: {
                type: 'big-number'
            }
        };

        chainWithPendingUpdates(document, (edit) => {
            const newCell = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify(bigNumberMetadata, null, 2),
                'json'
            );
            newCell.metadata = metadata;
            const nbEdit = NotebookEdit.insertCells(insertIndex, [newCell]);
            edit.set(document.uri, [nbEdit]);
        }).then(() => {
            editor.selection = new NotebookRange(insertIndex, insertIndex + 1);
        }, noop);
    }
}
