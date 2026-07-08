import { parseSnapshotFilename } from '@deepnote/convert';
import { Uri } from 'vscode';

/** File suffix for snapshot files */
export const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

/**
 * Checks if a URI represents a snapshot file
 */
export function isSnapshotFile(uri: Uri): boolean {
    return uri.path.endsWith(SNAPSHOT_FILE_SUFFIX);
}

/**
 * Extracts the project ID from a snapshot file URI. Handles the notebook-scoped
 * `${slug}_${projectId}_${encodedNotebookId}_${variant}` and legacy project-scoped
 * `${slug}_${projectId}_${variant}` forms via convert's `parseSnapshotFilename`.
 * @returns The project ID, or undefined if the URI is not a valid snapshot file
 */
export function extractProjectIdFromSnapshotUri(uri: Uri): string | undefined {
    const basename = uri.path.split('/').pop() ?? '';
    const parsed = parseSnapshotFilename(basename);

    return parsed?.projectId;
}
