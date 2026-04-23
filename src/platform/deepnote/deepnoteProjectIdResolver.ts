import { NotebookDocument, Uri } from 'vscode';

import { logger } from '../logging';
import { readDeepnoteProjectFile } from './deepnoteProjectFileReader';

/**
 * Resolve the Deepnote project id for an open notebook document.
 * Prefers the pre-populated `deepnoteProjectId` metadata set by the serializer;
 * falls back to reading the YAML on disk if metadata is missing.
 */
export async function resolveProjectIdForNotebook(notebook: NotebookDocument): Promise<string | undefined> {
    const metadataProjectId = notebook.metadata?.deepnoteProjectId as string | undefined;
    if (metadataProjectId) {
        return metadataProjectId;
    }

    const baseFileUri = notebook.uri.with({ query: '', fragment: '' });

    return resolveProjectIdForFile(baseFileUri);
}

/**
 * Resolve the Deepnote project id for a `.deepnote` file on disk by parsing the
 * YAML content. Swallows I/O/parse errors and returns `undefined` on failure.
 */
export async function resolveProjectIdForFile(fileUri: Uri): Promise<string | undefined> {
    try {
        const parsed = await readDeepnoteProjectFile(fileUri);

        return parsed?.project?.id;
    } catch (error) {
        logger.warn(`Failed to resolve Deepnote project id for ${fileUri.toString()}`, error);

        return undefined;
    }
}
