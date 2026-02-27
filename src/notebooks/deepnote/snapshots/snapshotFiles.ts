import { Uri } from 'vscode';

import { InvalidProjectNameError } from '../../../platform/errors/invalidProjectNameError';

/** File suffix for snapshot files */
export const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

/** Regex pattern for extracting project ID from snapshot filenames. */
const SNAPSHOT_FILENAME_PATTERN = new RegExp(`^[a-z0-9-]+_(.+)_[^_]+${SNAPSHOT_FILE_SUFFIX.replace(/\./g, '\\.')}$`);

/**
 * Checks if a URI represents a snapshot file
 */
export function isSnapshotFile(uri: Uri): boolean {
    return uri.path.endsWith(SNAPSHOT_FILE_SUFFIX);
}

/**
 * Extracts the project ID from a snapshot file URI.
 * Snapshot filenames follow: `${slug}_${projectId}_${variant}.snapshot.deepnote`
 * @returns The project ID, or undefined if the URI is not a valid snapshot file
 */
export function extractProjectIdFromSnapshotUri(uri: Uri): string | undefined {
    const basename = uri.path.split('/').pop() ?? '';
    const match = basename.match(SNAPSHOT_FILENAME_PATTERN);

    return match?.[1];
}

/**
 * Slugifies a project name for use in filenames.
 * Converts to lowercase, replaces spaces with hyphens, removes non-alphanumeric chars.
 * @throws Error if the result is empty after transformation
 */
export function slugifyProjectName(name: string): string {
    if (typeof name !== 'string' || !name.trim()) {
        throw new InvalidProjectNameError();
    }

    const slug = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (!slug) {
        throw new InvalidProjectNameError();
    }

    return slug;
}
