// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { injectable } from 'inversify';
import { workspace, Disposable } from 'vscode';
import { IExtensionSyncActivationService } from '../platform/activation/types';
import { CustomNotebookSerializer } from './customCellSerializer';

@injectable()
export class CustomNotebookService implements IExtensionSyncActivationService {
    private disposables: Disposable[] = [];

    public activate(): void {
        // Register the custom notebook serializer
        this.disposables.push(
            workspace.registerNotebookSerializer(
                'custom-notebook',
                new CustomNotebookSerializer(),
                {
                    transientCellMetadata: {},
                    transientDocumentMetadata: {},
                    transientOutputs: false
                }
            )
        );
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
}