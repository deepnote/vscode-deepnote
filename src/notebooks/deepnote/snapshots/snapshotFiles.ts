import { Uri } from 'vscode';

import { InvalidProjectNameError } from '../../../platform/errors/invalidProjectNameError';

/** File suffix for snapshot files */
export const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

/**
 * Checks if a URI represents a snapshot file
 */
export function isSnapshotFile(uri: Uri): boolean {
    return uri.path.endsWith(SNAPSHOT_FILE_SUFFIX);
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
