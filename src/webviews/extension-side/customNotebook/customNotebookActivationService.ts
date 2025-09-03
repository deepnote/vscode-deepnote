// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { Disposable, window } from 'vscode';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposable } from '../../../platform/common/types';
import { CustomNotebookProvider } from './customNotebookProvider';

@injectable()
export class CustomNotebookActivationService implements IExtensionSyncActivationService, IDisposable {
    private readonly disposables: Disposable[] = [];

    constructor(
        @inject(CustomNotebookProvider) private readonly customNotebookProvider: CustomNotebookProvider
    ) {}

    public activate(): void {
        // Register the custom editor provider
        this.disposables.push(
            window.registerCustomEditorProvider(
                'jupyter.customNotebook',
                this.customNotebookProvider,
                {
                    webviewOptions: {
                        retainContextWhenHidden: true,
                        enableFindWidget: true
                    },
                    supportsMultipleEditorsPerDocument: false
                }
            )
        );
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
    }
}