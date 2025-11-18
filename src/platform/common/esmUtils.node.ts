// Copyright (c) Deepnote. All rights reserved.
// Licensed under the MIT License.

import { fileURLToPath } from 'url';
// eslint-disable-next-line local-rules/node-imports
import { dirname } from 'path';

/**
 * Get the directory name equivalent to __dirname in ESM context.
 * @param importMetaUrl - Pass import.meta.url
 * @returns The directory path
 */
export function getDirname(importMetaUrl: string): string {
    return dirname(fileURLToPath(importMetaUrl));
}

/**
 * Get the file name equivalent to __filename in ESM context.
 * @param importMetaUrl - Pass import.meta.url
 * @returns The file path
 */
export function getFilename(importMetaUrl: string): string {
    return fileURLToPath(importMetaUrl);
}
