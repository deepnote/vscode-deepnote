import { createHash } from 'crypto';
import { Uri } from 'vscode';

/**
 * Returns a stable storage key for a Deepnote notebook URI.
 * The key preserves query parameters (used to distinguish notebooks within the same .deepnote file)
 * but strips fragments to avoid editor-specific noise.
 */
export function getDeepnoteNotebookStorageKey(uri: Uri): string {
    const normalized = uri.with({ fragment: '' });
    return normalized.toString();
}

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
 * Returns a stable key for all notebooks within a Deepnote project.
 * Falls back to a hashed notebook path if a project identifier is unavailable.
 */
export function getDeepnoteProjectStorageKey(uri: Uri, projectId?: string | null): string {
    if (projectId && projectId.trim().length > 0) {
        return `project:${projectId.trim()}`;
    }

    return `notebook:${getDeepnoteNotebookStorageKey(uri)}`;
}

/**
 * Generates a hash for a Deepnote project key that can be embedded safely in identifiers.
 */
export function getDeepnoteProjectKeyHash(uri: Uri, projectId?: string | null, length = 24): string {
    const key = getDeepnoteProjectStorageKey(uri, projectId);
    return createHash('sha256').update(key).digest('hex').slice(0, length);
}

