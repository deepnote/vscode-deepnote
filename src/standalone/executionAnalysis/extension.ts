// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { noop } from './common';

/**
 * ExecutionAnalysis feature is currently disabled.
 * It previously relied on Pylance for cell dependency tracking.
 * TODO: Adapt to use DeepnoteLspClientManager for language features.
 */
export async function activate(_context: vscode.ExtensionContext): Promise<void> {
    const optInto = vscode.workspace.getConfiguration('deepnote').get<boolean>('executionAnalysis.enabled');
    if (!optInto) {
        return;
    }

    // Feature disabled - previously required Pylance for cell dependency analysis
    return;
}

// This method is called when your extension is deactivated
export function deactivate() {
    noop();
}
