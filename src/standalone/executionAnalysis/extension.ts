// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { activatePylance } from './pylance';
import { findNotebookAndCell, noop } from './common';
import { ExecutionFixCodeActionsProvider, SymbolsTracker } from './symbols';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const optInto = vscode.workspace.getConfiguration('deepnote').get<boolean>('executionAnalysis.enabled');
    if (!optInto) {
        return;
    }

    const referencesProvider = await activatePylance();
    if (!referencesProvider) {
        return;
    }

    const symbolsManager = new SymbolsTracker(referencesProvider);
    context.subscriptions.push(symbolsManager);

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'deepnote.selectDependentCells',
            async (cell: vscode.NotebookCell | undefined) => {
                const matched = findNotebookAndCell(cell);
                if (!matched) {
                    return;
                }

                const { notebook, cell: currentCell } = matched;
                await symbolsManager.selectSuccessorCells(notebook, currentCell);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepnote.runPrecedentCells', async (cell: vscode.NotebookCell | undefined) => {
            const matched = findNotebookAndCell(cell);
            if (!matched) {
                return;
            }

            const { notebook, cell: currentCell } = matched;
            await symbolsManager.runPrecedentCells(notebook, currentCell);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepnote.runDependentCells', async (cell: vscode.NotebookCell | undefined) => {
            const matched = findNotebookAndCell(cell);
            if (!matched) {
                return;
            }

            const { notebook, cell: currentCell } = matched;
            await symbolsManager.runSuccessorCells(notebook, currentCell);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'deepnote.selectPrecedentCells',
            async (cell: vscode.NotebookCell | undefined) => {
                const matched = findNotebookAndCell(cell);
                if (!matched) {
                    return;
                }

                const { notebook, cell: currentCell } = matched;
                await symbolsManager.selectPrecedentCells(notebook, currentCell);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepnote.debugCellSymbols', async () => {
            const notebookEditor = vscode.window.activeNotebookEditor;
            if (notebookEditor) {
                await symbolsManager.debugSymbols(notebookEditor.notebook);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'python', notebookType: 'jupyter-notebook' },
            new ExecutionFixCodeActionsProvider(symbolsManager),
            {
                providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
            }
        )
    );
}

// This method is called when your extension is deactivated
export function deactivate() {
    noop();
}
