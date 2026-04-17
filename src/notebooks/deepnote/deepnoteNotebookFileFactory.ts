import { type DeepnoteFile } from '@deepnote/blocks';
import { Uri } from 'vscode';

import { computeHash } from '../../platform/common/crypto';
import type { DeepnoteNotebook } from '../../platform/deepnote/deepnoteTypes';
import { slugifyProjectName } from './snapshots/snapshotFiles';

/**
 * Builds a new DeepnoteFile containing a single user notebook (plus optional init notebook),
 * sharing the source's project id, name, version, and metadata.
 */
export async function buildSingleNotebookFile(source: DeepnoteFile, notebook: DeepnoteNotebook): Promise<DeepnoteFile> {
    const initNotebookId = source.project.initNotebookId;
    const initNotebook = initNotebookId ? source.project.notebooks.find((nb) => nb.id === initNotebookId) : undefined;

    const metadata = source.metadata ? structuredClone(source.metadata) : { createdAt: new Date().toISOString() };

    metadata.modifiedAt = new Date().toISOString();

    const notebooks = initNotebook ? [structuredClone(initNotebook), notebook] : [notebook];

    const newProject: DeepnoteFile = {
        metadata,
        project: {
            ...source.project,
            notebooks
        },
        version: source.version
    };

    if (initNotebook && initNotebookId) {
        newProject.project.initNotebookId = initNotebookId;
    } else {
        delete newProject.project.initNotebookId;
    }

    (newProject.metadata as Record<string, unknown>).snapshotHash = await computeSnapshotHash(newProject);

    return newProject;
}

/**
 * Builds a sibling file URI for a notebook based on the original file's stem and a slugified notebook name.
 * If the resulting path already exists, appends `_2`, `_3`, ... until a unique name is found.
 */
export async function buildSiblingNotebookFileUri(
    originalUri: Uri,
    notebookName: string,
    exists: (uri: Uri) => Promise<boolean>
): Promise<Uri> {
    const parentDir = Uri.joinPath(originalUri, '..');
    const originalStem = getFileStem(originalUri);
    const slug = slugifyNotebookNameOrFallback(notebookName);
    const baseName = `${originalStem}_${slug}`;

    let candidate = Uri.joinPath(parentDir, `${baseName}.deepnote`);
    let suffix = 2;

    while (await exists(candidate)) {
        candidate = Uri.joinPath(parentDir, `${baseName}_${suffix}.deepnote`);
        suffix++;
    }

    return candidate;
}

/**
 * Computes snapshotHash using the same algorithm as DeepnoteNotebookSerializer.
 */
export async function computeSnapshotHash(project: DeepnoteFile): Promise<string> {
    const contentHashes: string[] = [];

    for (const notebook of project.project.notebooks) {
        for (const block of notebook.blocks ?? []) {
            if (block.contentHash) {
                contentHashes.push(block.contentHash);
            }
        }
    }

    contentHashes.sort();

    const hashInput = {
        contentHashes,
        environmentHash: project.environment?.hash ?? null,
        integrations: (project.project.integrations ?? [])
            .map((i: { id: string; name: string; type: string }) => ({ id: i.id, name: i.name, type: i.type }))
            .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
        version: project.version
    };

    const hashData = JSON.stringify(hashInput);
    const hash = await computeHash(hashData, 'SHA-256');

    return `sha256:${hash}`;
}

/**
 * Extracts the file stem (portion before the first dot) from a URI's basename.
 */
export function getFileStem(uri: Uri): string {
    const basename = uri.path.split('/').pop() ?? '';
    const dotIndex = basename.indexOf('.');

    return dotIndex > 0 ? basename.slice(0, dotIndex) : basename;
}

/**
 * Slugifies a notebook name, falling back to 'notebook' if the name cannot be slugified.
 */
export function slugifyNotebookNameOrFallback(name: string): string {
    try {
        return slugifyProjectName(name);
    } catch {
        // Fallback for names that produce empty slugs
        return 'notebook';
    }
}
