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
 * Extracts the project ID from a snapshot file URI.
 * Snapshot filenames follow: `${slug}_${projectId}_${variant}.snapshot.deepnote`
 * The slug uses only [a-z0-9-], so the first `_` separates slug from projectId,
 * and the last `_` separates projectId from variant.
 * @returns The project ID, or undefined if the URI is not a valid snapshot file
 */
export function extractProjectIdFromSnapshotUri(uri: Uri): string | undefined {
    const basename = uri.path.split('/').pop() ?? '';
    if (!basename.endsWith(SNAPSHOT_FILE_SUFFIX)) {
        return undefined;
    }
    const stem = basename.slice(0, -SNAPSHOT_FILE_SUFFIX.length);
    const firstUnderscore = stem.indexOf('_');
    const lastUnderscore = stem.lastIndexOf('_');
    if (firstUnderscore === -1 || lastUnderscore === -1 || firstUnderscore === lastUnderscore) {
        return undefined;
    }
    return stem.slice(firstUnderscore + 1, lastUnderscore);
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
