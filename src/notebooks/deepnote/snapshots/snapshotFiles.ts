import { Uri } from 'vscode';

import { InvalidProjectNameError } from '../../../platform/errors/invalidProjectNameError';

/** File suffix for snapshot files */
export const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

/**
 * Regex pattern for extracting project ID and notebook ID from snapshot filenames.
 * New format: {slug}_{projectId}_{notebookId}_{variant}.snapshot.deepnote
 */
const SNAPSHOT_FILENAME_PATTERN = new RegExp(
    `^[a-z0-9-]+_(.+)_([a-f0-9-]+)_[^_]+${SNAPSHOT_FILE_SUFFIX.replace(/\./g, '\\.')}$`
);

/**
 * Legacy pattern for old-format snapshots without notebook ID.
 * Old format: {slug}_{projectId}_{variant}.snapshot.deepnote
 */
const LEGACY_SNAPSHOT_FILENAME_PATTERN = new RegExp(
    `^[a-z0-9-]+_(.+)_[^_]+${SNAPSHOT_FILE_SUFFIX.replace(/\./g, '\\.')}$`
);

/**
 * Checks if a URI represents a snapshot file
 */
export function isSnapshotFile(uri: Uri): boolean {
    return uri.path.endsWith(SNAPSHOT_FILE_SUFFIX);
}

/**
 * Extracts the project ID from a snapshot file URI.
 * Supports both new format ({slug}_{projectId}_{notebookId}_{variant}) and
 * legacy format ({slug}_{projectId}_{variant}).
 * @returns The project ID, or undefined if the URI is not a valid snapshot file
 */
export function extractProjectIdFromSnapshotUri(uri: Uri): string | undefined {
    const basename = uri.path.split('/').pop() ?? '';

    // Try new format first
    const newMatch = basename.match(SNAPSHOT_FILENAME_PATTERN);
    if (newMatch) {
        return newMatch[1];
    }

    // Fall back to legacy format
    const legacyMatch = basename.match(LEGACY_SNAPSHOT_FILENAME_PATTERN);
    return legacyMatch?.[1];
}

/**
 * Extracts the notebook ID from a snapshot file URI.
 * Only works with new format: {slug}_{projectId}_{notebookId}_{variant}.snapshot.deepnote
 * @returns The notebook ID, or undefined if the URI uses legacy format or is invalid
 */
export function extractNotebookIdFromSnapshotUri(uri: Uri): string | undefined {
    const basename = uri.path.split('/').pop() ?? '';
    const match = basename.match(SNAPSHOT_FILENAME_PATTERN);

    return match?.[2];
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
