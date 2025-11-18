// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from './vscode-path/path';
import { createRequire } from 'module';

import { getDirname } from './common/esmUtils.node';

const require = createRequire(import.meta.url);
const __dirname = getDirname(import.meta.url);

// We always use esbuild to bundle the extension,
// Thus __dirname will always be a file in `dist` folder.
export const EXTENSION_ROOT_DIR = path.join(__dirname, '..');

// Re-export everything from base constants except isPreReleaseVersion
export * from './constants';

// Override isPreReleaseVersion with Node.js-specific implementation
export function isPreReleaseVersion(): boolean {
    try {
        return require('vscode-jupyter-release-version').isPreRelesVersionOfJupyterExtension === true;
    } catch {
        // Dev version is treated as pre-release.
        return true;
    }
}
