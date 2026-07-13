import { z } from 'zod';
import { NotebookDocument, Uri } from 'vscode';

import { logger } from '../logging';
import { readDeepnoteProjectFile } from './deepnoteProjectFileReader';

/**
 * Reads the `.deepnote` file at `fileUri` and returns its `project.id`.
 * I/O and parse errors are swallowed so callers treat an unreadable file as "no project".
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
 * Resolves a notebook's Deepnote `project.id`, preferring the `deepnoteProjectId` metadata and
 * falling back to reading the underlying file (query/fragment stripped from the URI).
 */
export async function resolveProjectIdForNotebook(notebook: NotebookDocument): Promise<string | undefined> {
    const projectIdFromMetadata = notebook.metadata?.deepnoteProjectId;

    const projectIdFromMetadataResult = z.string().min(1).safeParse(projectIdFromMetadata);

    if (projectIdFromMetadataResult.success) {
        return projectIdFromMetadataResult.data;
    }

    const fileUri = notebook.uri.with({ query: '', fragment: '' });

    return resolveProjectIdForFile(fileUri);
}
