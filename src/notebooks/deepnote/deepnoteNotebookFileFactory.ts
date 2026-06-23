import { Uri } from 'vscode';
import type { DeepnoteFile } from '@deepnote/blocks';
import { slugifyProjectName } from '@deepnote/convert';

import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { allocateSiblingUri } from './deepnoteSiblingFileAllocator';

const FALLBACK_NOTEBOOK_SLUG = 'notebook';
const DEEPNOTE_EXTENSION = '.deepnote';

/**
 * Returns the basename of a URI up to (but not including) the FIRST `.`.
 * e.g. `report.backup.deepnote` → `report`.
 * @param uri The file URI
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
 *
 * Clones `source.metadata` (or `{ createdAt: now }`), stamps `modifiedAt = now`, preserves
 * the source's top-level fields, spreads `source.project` (preserving `id`, `name`,
 * `integrations`, `settings`, and carrying `initNotebookId` forward), and sets
 * `notebooks` to the single provided notebook.
 *
 * Note: `metadata.snapshotHash` is intentionally NOT stamped — it is a snapshot-only field
 * that `serializeDeepnoteFile` strips, so stamping it on a source file is a no-op.
 *
 * @param source The source file to derive project-level metadata from
 * @param notebook The single notebook the new file should contain
 * @returns A new single-notebook `DeepnoteFile`
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
 * Compute a collision-free sibling URI for a new notebook file, named consistently with
 * `@deepnote/convert`'s split output (`{stem}-{slug}.deepnote`).
 *
 * The desired basename is `${getFileStem(originalUri)}-${slugifyProjectName(notebookName) || 'notebook'}.deepnote`;
 * collision handling is delegated to the shared `allocateSiblingUri` from §0.
 *
 * @param originalUri The URI of the originating file (used for parent dir + stem)
 * @param notebookName The name of the notebook (slugified into the filename)
 * @param exists Injected existence probe
 * @returns A collision-free URI for the new sibling file
 */
export async function buildSiblingNotebookFileUri(
    originalUri: Uri,
    notebookName: string,
    exists: (uri: Uri) => Promise<boolean>
): Promise<Uri> {
    const parentDir = Uri.joinPath(originalUri, '..');
    const slug = slugifyProjectName(notebookName) || FALLBACK_NOTEBOOK_SLUG;
    const desiredFilename = `${getFileStem(originalUri)}-${slug}${DEEPNOTE_EXTENSION}`;

    return allocateSiblingUri(parentDir, desiredFilename, exists);
}
