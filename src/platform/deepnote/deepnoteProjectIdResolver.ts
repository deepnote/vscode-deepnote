import { NotebookDocument, Uri } from 'vscode';

import { logger } from '../logging';
import { readDeepnoteProjectFile } from './deepnoteProjectFileReader';

/**
 * Resolves the Deepnote `project.id` that a given file belongs to.
 *
 * Reads and parses the `.deepnote` file at `fileUri` and returns its `project.id`.
 * I/O and parse errors are swallowed (logged) so callers can treat an unreadable or
 * malformed file as "no project".
 *
 * @param fileUri The URI of the `.deepnote` file.
 * @returns The project id, or `undefined` if it cannot be determined.
 */
export async function resolveProjectIdForFile(fileUri: Uri): Promise<string | undefined> {
    try {
        const deepnoteFile = await readDeepnoteProjectFile(fileUri);

        return deepnoteFile.project?.id;
    } catch (error) {
        logger.warn(`Failed to resolve Deepnote project id for file ${fileUri.toString()}`, error);

        return undefined;
    }
}

/**
 * Resolves the Deepnote `project.id` for a notebook document.
 *
 * Prefers the project id stamped on the notebook metadata (`deepnoteProjectId`);
 * when that is absent it falls back to reading the underlying file (with any query
 * and fragment stripped from the notebook URI).
 *
 * @param notebook The notebook document.
 * @returns The project id, or `undefined` if it cannot be determined.
 */
export async function resolveProjectIdForNotebook(notebook: NotebookDocument): Promise<string | undefined> {
    const projectIdFromMetadata = notebook.metadata?.deepnoteProjectId;

    if (typeof projectIdFromMetadata === 'string' && projectIdFromMetadata) {
        return projectIdFromMetadata;
    }

    const fileUri = notebook.uri.with({ query: '', fragment: '' });

    return resolveProjectIdForFile(fileUri);
}
