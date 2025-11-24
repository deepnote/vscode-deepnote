// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { IExtensionApi } from './standalone/api';
import type { IExtensionContext } from './platform/common/types';
import { ExtensionMode } from 'vscode';

let realEntryPoint: {
    activate: typeof activate;
    deactivate: typeof deactivate;
};

export async function activate(context: IExtensionContext): Promise<IExtensionApi> {
    // Use dynamic path construction to prevent esbuild from bundling the module
    // Must use explicit './' prefix for ESM imports to work correctly
    const entryPoint =
        context.extensionMode === ExtensionMode.Test ? '../out/extension.node.js' : './extension.node.js';
    try {
        realEntryPoint = await import(/* webpackIgnore: true */ entryPoint);
        return realEntryPoint.activate(context);
    } catch (ex) {
        if (!ex.toString().includes(`Cannot find module '../out/extension.node.js'`)) {
            console.error('Failed to activate extension, falling back to `./extension.node.js`', ex);
        }
        // In smoke tests, we do not want to load the out/extension.node.
        const fallbackPath = './extension.node.js';
        realEntryPoint = await import(/* webpackIgnore: true */ fallbackPath);
        return realEntryPoint.activate(context);
    }
}

export function deactivate(): Thenable<void> {
    return realEntryPoint.deactivate();
}
