import {
    decodeNotebookIdFromFilename,
    encodeNotebookIdForFilename,
    generateSnapshotFilename,
    parseSnapshotFilename,
    resolveSnapshotNotebookId,
    slugifyProjectName
} from '@deepnote/convert';
import { Uri } from 'vscode';

/** File suffix for snapshot files */
export const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

/**
 * Re-export the snapshot filename helpers from `@deepnote/convert` so the snapshot service
 * and tests share a single, CLI-compatible implementation of the filename grammar (which
 * percent-encodes the notebook id and NFD-normalizes accents). The local hand-written
 * regex/slugify previously diverged from the CLI and is gone.
 */
export {
    decodeNotebookIdFromFilename,
    encodeNotebookIdForFilename,
    generateSnapshotFilename,
    parseSnapshotFilename,
    resolveSnapshotNotebookId,
    slugifyProjectName
};

/**
 * Checks if a URI represents a snapshot file
 */
export function isSnapshotFile(uri: Uri): boolean {
    return uri.path.endsWith(SNAPSHOT_FILE_SUFFIX);
}

/**
 * Extracts the project ID from a snapshot file URI.
 *
 * Snapshot filenames follow the notebook-scoped form
 * `${slug}_${projectId}_${encodedNotebookId}_${variant}.snapshot.deepnote` or the legacy
 * project-scoped form `${slug}_${projectId}_${variant}.snapshot.deepnote`. Both are handled
 * by convert's `parseSnapshotFilename` (which also decodes the percent-encoded notebook id).
 * @returns The project ID, or undefined if the URI is not a valid snapshot file
 */
export function extractProjectIdFromSnapshotUri(uri: Uri): string | undefined {
    const basename = uri.path.split('/').pop() ?? '';
    const parsed = parseSnapshotFilename(basename);

    return parsed?.projectId;
}
