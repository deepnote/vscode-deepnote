import { serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { generateSnapshotFilename, parseSnapshotFilename, slugifyProjectName } from '@deepnote/convert';
import { FileType, Uri, workspace } from 'vscode';
import { Utils } from 'vscode-uri';

import { InvalidProjectNameError } from '../../../platform/errors/invalidProjectNameError';
import { logger } from '../../../platform/logging';

/** File suffix for snapshot files */
export const SNAPSHOT_FILE_SUFFIX = '.snapshot.deepnote';

export function buildSnapshotPath({
    notebookId,
    projectId,
    projectName,
    projectUri,
    variant
}: {
    notebookId?: string;
    projectId: string;
    projectName: string;
    projectUri: Uri;
    variant: 'latest' | string;
}): Uri {
    const parentDir = Uri.joinPath(projectUri, '..');

    if (projectName.trim().length <= 0) {
        throw new InvalidProjectNameError();
    }

    const slug = slugifyProjectName(projectName);

    if (!slug) {
        throw new InvalidProjectNameError();
    }

    const filename = generateSnapshotFilename({ slug, projectId, notebookId, timestamp: variant });

    return Uri.joinPath(parentDir, 'snapshots', filename);
}

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

/** Encodes `file` as the UTF-8 YAML that snapshot files hold. */
export function encodeSnapshotFile(file: DeepnoteFile): Uint8Array {
    return new TextEncoder().encode(serializeDeepnoteFile(file));
}

/** Creates `snapshotsDir` if missing; logs an error and resolves `false` if it is not or cannot become a directory. */
export async function ensureSnapshotsDirectory(snapshotsDir: Uri): Promise<boolean> {
    try {
        const stat = await workspace.fs.stat(snapshotsDir);

        if (stat.type !== FileType.Directory) {
            logger.error(`[Snapshot] Snapshots path exists but is not a directory: ${Utils.basename(snapshotsDir)}`);

            return false;
        }

        return true;
    } catch {
        logger.debug(`[Snapshot] Creating snapshots directory: ${Utils.basename(snapshotsDir)}`);

        try {
            await workspace.fs.createDirectory(snapshotsDir);

            return true;
        } catch (error) {
            logger.error(`[Snapshot] Failed to create snapshots directory: ${Utils.basename(snapshotsDir)}`, error);

            return false;
        }
    }
}
