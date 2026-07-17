import { Uri } from 'vscode';
import type { DeepnoteFile } from '@deepnote/blocks';
import { slugifyProjectName } from '@deepnote/convert';

import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { allocateSiblingUri } from './deepnoteSiblingFileAllocator';

const FALLBACK_NOTEBOOK_SLUG = 'notebook';
const FALLBACK_PROJECT_SLUG = 'project';
const DEEPNOTE_EXTENSION = '.deepnote';

/**
 * Returns the basename of a URI up to (but not including) the first `.`,
 * e.g. `report.backup.deepnote` → `report`.
 */
export function getFileStem(uri: Uri): string {
    const fileName = uri.path.split('/').pop() ?? '';
    const firstDotIndex = fileName.indexOf('.');

    if (firstDotIndex === -1) {
        return fileName;
    }

    return fileName.slice(0, firstDotIndex);
}

/**
 * Build a new single-notebook `DeepnoteFile` from a source file and a single notebook.
 * `metadata.snapshotHash` is intentionally not stamped — it is a snapshot-only field that
 * `serializeDeepnoteFile` strips, so stamping it on a source file is a no-op.
 */
export function buildSingleNotebookFile(source: DeepnoteFile, notebook: DeepnoteNotebook): DeepnoteFile {
    const now = new Date().toISOString();
    const metadata = source.metadata ? { ...source.metadata } : { createdAt: now };

    metadata.modifiedAt = now;

    return {
        ...source,
        metadata,
        project: {
            ...source.project,
            notebooks: [notebook]
        }
    };
}

/**
 * Compute a collision-free sibling URI for a new notebook file: `{projectSlug}-{notebookSlug}.deepnote`,
 * placed alongside `originalUri`. The stem is derived from the project NAME (never from a sibling
 * filename), so it stays stable no matter which sibling seeds the add and can never accumulate other
 * notebooks' names. Matches the `slugifyProjectName(project.name)` convention used for snapshot filenames.
 */
export async function buildSiblingNotebookFileUri(
    originalUri: Uri,
    projectName: string,
    notebookName: string,
    exists: (uri: Uri) => Promise<boolean>
): Promise<Uri> {
    const parentDir = Uri.joinPath(originalUri, '..');
    const projectSlug = slugifyProjectName(projectName) || FALLBACK_PROJECT_SLUG;
    const notebookSlug = slugifyProjectName(notebookName) || FALLBACK_NOTEBOOK_SLUG;
    const desiredFilename = `${projectSlug}-${notebookSlug}${DEEPNOTE_EXTENSION}`;

    return allocateSiblingUri(parentDir, desiredFilename, exists);
}
