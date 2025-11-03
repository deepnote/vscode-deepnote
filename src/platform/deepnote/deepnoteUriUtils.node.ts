import { createHash } from 'crypto';
import { Uri } from 'vscode';

import { getDeepnoteNotebookStorageKey, getDeepnoteProjectStorageKey } from './deepnoteUriUtils';

/**
 * Legacy key that only relied on the file system path (used prior to multi-notebook support).
 * Retained for backwards compatibility with persisted workspace state.
 */
export function getLegacyDeepnoteNotebookStorageKey(uri: Uri): string {
    const normalized = uri.with({ query: '', fragment: '' });
    return normalized.fsPath;
}

/**
 * Generates a short hash for a Deepnote notebook URI that can be safely embedded in identifiers.
 */
export function getDeepnoteNotebookKeyHash(uri: Uri, length = 16): string {
    const key = getDeepnoteNotebookStorageKey(uri);
    return createHash('sha256').update(key).digest('hex').slice(0, length);
}

/**
 * Generates a hash for a Deepnote project key that can be embedded safely in identifiers.
 */
export function getDeepnoteProjectKeyHash(uri: Uri, projectId?: string | null, length = 24): string {
    const key = getDeepnoteProjectStorageKey(uri, projectId);
    return createHash('sha256').update(key).digest('hex').slice(0, length);
}

export { getDeepnoteNotebookStorageKey, getDeepnoteProjectStorageKey } from './deepnoteUriUtils';
