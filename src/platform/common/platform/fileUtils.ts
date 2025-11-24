// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getOSType, OSType } from '../utils/platform';
import * as path from '../../../platform/vscode-path/path';

export function normCasePath(filePath: string): string {
    return getOSType() === OSType.Windows ? path.normalize(filePath).toUpperCase() : path.normalize(filePath);
}

function arePathsSameImpl(path1: string, path2: string): boolean {
    return normCasePath(path1) === normCasePath(path2);
}

// Export through a mutable object to allow stubbing in ESM tests
export const fileUtilsCommonUtils = {
    arePathsSame: arePathsSameImpl
};

// Keep original export for backwards compatibility
export const arePathsSame = fileUtilsCommonUtils.arePathsSame;

/**
 * Returns true if given file path exists within the given parent directory, false otherwise.
 * @param filePath File path to check for
 * @param parentPath The potential parent path to check for
 */
export function isParentPath(filePath: string, parentPath: string): boolean {
    if (!parentPath.endsWith(path.sep)) {
        parentPath += path.sep;
    }
    if (!filePath.endsWith(path.sep)) {
        filePath += path.sep;
    }
    return normCasePath(filePath).startsWith(normCasePath(parentPath));
}
