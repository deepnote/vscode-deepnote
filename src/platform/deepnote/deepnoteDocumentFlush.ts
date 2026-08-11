import { Uri, workspace } from 'vscode';

import { logger } from '../logging';

/**
 * Saves a dirty open notebook for `fileUri` before a disk read-modify-write so live edits are not
 * overwritten; callers that read the file first must re-read it when this returns `true`.
 *
 * @returns `false` only when a dirty document could not be saved (the save was declined or threw).
 */
export async function flushNotebookDocumentIfDirty(fileUri: Uri): Promise<boolean> {
    const openDocument = workspace.notebookDocuments.find(
        (doc) => doc.uri.with({ query: '', fragment: '' }).toString() === fileUri.toString()
    );

    if (!openDocument?.isDirty) {
        return true;
    }

    try {
        return await openDocument.save();
    } catch (error) {
        logger.error(`Failed to save Deepnote file before a disk rewrite: ${fileUri.toString()}`, error);

        return false;
    }
}
