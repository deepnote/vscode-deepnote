// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from './vscode-path/path';

// We always use esbuild to bundle the extension,
// Thus __dirname will always be a file in `dist` folder.
export const EXTENSION_ROOT_DIR = path.join(__dirname, '..');

// Re-export everything from base constants except isPreReleaseVersion
export * from './constants';

// Override isPreReleaseVersion with Node.js-specific implementation
export function isPreReleaseVersion(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isPreRelease } = require('vscode-jupyter-release-version') as { isPreRelease?: boolean };
        return isPreRelease === true;
    } catch {
        // Dev version is treated as pre-release.
        return true;
    }
}
