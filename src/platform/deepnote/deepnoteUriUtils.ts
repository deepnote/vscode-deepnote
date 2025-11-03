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
 * Returns a stable key for all notebooks within a Deepnote project.
 * Falls back to a hashed notebook path if a project identifier is unavailable.
 */
export function getDeepnoteProjectStorageKey(uri: Uri, projectId?: string | null): string {
    if (projectId && projectId.trim().length > 0) {
        return `project:${projectId.trim()}`;
    }

    return `notebook:${getDeepnoteNotebookStorageKey(uri)}`;
}
