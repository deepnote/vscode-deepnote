// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { IExtensionSyncActivationService } from '../../activation/types';
import { IDisposableRegistry } from '../../common/types';
import { noop } from '../../common/utils/misc';
import { commands } from 'vscode';

@injectable()
export class PythonFilterUICommandDeprecation implements IExtensionSyncActivationService {
    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {}
    public activate() {
        this.disposables.push(
            commands.registerCommand(
                'deepnote.filterKernels',
                () =>
                    commands
                        .executeCommand('workbench.action.openSettings', 'deepnote.kernels.excludePythonEnvironments')
                        .then(noop, noop),
                this
            )
        );
    }
}
