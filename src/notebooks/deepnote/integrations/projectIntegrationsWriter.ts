import { serializeDeepnoteFile } from '@deepnote/blocks';
import { RelativePattern, Uri, workspace } from 'vscode';

import { flushNotebookDocumentIfDirty } from '../../../platform/deepnote/deepnoteDocumentFlush';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { isSnapshotFile } from '../snapshots/snapshotFiles';

/**
 * Applies a project's integration list everywhere it lives, deterministically and regardless of which
 * siblings are open: writes `project.integrations` into every sibling `.deepnote` file on disk and
 * refreshes the in-memory cache for the open ones. Only `project.integrations` is rewritten — every
 * other field (incl. notebook blocks) round-trips from disk, so a sibling's saved cells are untouched.
 *
 * @returns `true` if the cache was refreshed or at least one file was written, `false` otherwise.
 */
export async function persistProjectIntegrations(
    notebookManager: IDeepnoteNotebookManager,
    projectId: string,
    integrations: ProjectIntegration[]
): Promise<boolean> {
    // Refresh the in-memory cache (open siblings) first, so live env/kernel behavior stays correct
    // even if a subsequent disk write fails.
    const cacheUpdated = notebookManager.updateProjectIntegrations(projectId, integrations);

    let filesWritten = 0;

    for (const workspaceFolder of workspace.workspaceFolders || []) {
        let files: Uri[];

        try {
            files = await workspace.findFiles(new RelativePattern(workspaceFolder, '**/*.deepnote'));
        } catch (error) {
            logger.error('persistProjectIntegrations: failed to enumerate .deepnote files', error);

            continue;
        }

        for (const fileUri of files) {
            // Skip snapshot sidecars: they are output-only project clones, not editable sources.
            if (isSnapshotFile(fileUri)) {
                continue;
            }

            try {
                let projectData = await readDeepnoteProjectFile(fileUri);

                if (projectData?.project?.id !== projectId) {
                    continue;
                }

                // Flush an open, dirty sibling and re-read before rewriting, so we serialize its live
                // cell edits rather than clobbering them via the watcher reload. If the save is declined
                // we skip this sibling (its integrations sync on the next update) rather than clobber it.
                if (!(await flushNotebookDocumentIfDirty(fileUri))) {
                    logger.warn(
                        `persistProjectIntegrations: skipped ${fileUri.path} — unsaved edits could not be saved`
                    );

                    continue;
                }

                projectData = await readDeepnoteProjectFile(fileUri);

                // Rewrite ONLY the project-level integrations; every other field (incl. notebook
                // blocks) round-trips from disk verbatim, so a sibling's saved cells are untouched.
                projectData.project.integrations = integrations;

                if (!projectData.metadata) {
                    projectData.metadata = { createdAt: new Date().toISOString() };
                }

                projectData.metadata.modifiedAt = new Date().toISOString();

                await workspace.fs.writeFile(fileUri, new TextEncoder().encode(serializeDeepnoteFile(projectData)));
                filesWritten++;
            } catch (error) {
                logger.error(`persistProjectIntegrations: failed to update ${fileUri.path}`, error);
            }
        }
    }

    return cacheUpdated || filesWritten > 0;
}
