import { serializeDeepnoteFile } from '@deepnote/blocks';
import { RelativePattern, Uri, workspace } from 'vscode';

import { flushNotebookDocumentIfDirty } from '../../../platform/deepnote/deepnoteDocumentFlush';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { isSnapshotFile } from '../snapshots/snapshotFiles';

export interface PersistIntegrationsResult {
    activePersisted: boolean;
    siblingsFailed: number;
}

export interface PersistProjectIntegrationsParams {
    notebookManager: IDeepnoteNotebookManager;
    projectId: string;
    integrations: ProjectIntegration[];
    activeFileUri: Uri;
}

interface WriteIntegrationsToFileParams {
    fileUri: Uri;
    projectId: string;
    integrations: ProjectIntegration[];
}

type IntegrationWriteOutcome = 'failed' | 'skipped' | 'written';

/** Writes `integrations` to the active file and every on-disk sibling; `activePersisted` reflects disk truth, not the cache. */
export async function persistProjectIntegrations(
    params: PersistProjectIntegrationsParams
): Promise<PersistIntegrationsResult> {
    const { notebookManager, projectId, integrations, activeFileUri } = params;

    // Refresh the cache first so live env/kernel behavior stays correct even if a disk write fails.
    notebookManager.updateProjectIntegrations(projectId, integrations);

    // findFiles only covers open folders, so write the active file explicitly (no open folder / out-of-workspace).
    const activeOutcome = await writeIntegrationsToFile({ fileUri: activeFileUri, projectId, integrations });

    const visited = new Set<string>([activeFileUri.toString()]);
    let siblingsFailed = 0;

    for (const workspaceFolder of workspace.workspaceFolders || []) {
        let files: Uri[];

        try {
            files = await workspace.findFiles(new RelativePattern(workspaceFolder, '**/*.deepnote'));
        } catch (error) {
            logger.error('persistProjectIntegrations: failed to enumerate .deepnote files', error);

            continue;
        }

        for (const fileUri of files) {
            if (visited.has(fileUri.toString())) {
                continue;
            }

            visited.add(fileUri.toString());

            if ((await writeIntegrationsToFile({ fileUri, projectId, integrations })) === 'failed') {
                siblingsFailed++;
            }
        }
    }

    return { activePersisted: activeOutcome === 'written', siblingsFailed };
}

/** Returns `'skipped'` (snapshot / other project), `'failed'`, or `'written'` for one `.deepnote` file. */
async function writeIntegrationsToFile(params: WriteIntegrationsToFileParams): Promise<IntegrationWriteOutcome> {
    const { fileUri, projectId, integrations } = params;

    if (isSnapshotFile(fileUri)) {
        return 'skipped';
    }

    try {
        let projectData = await readDeepnoteProjectFile(fileUri);

        if (projectData?.project?.id !== projectId) {
            return 'skipped';
        }

        // Flush an open dirty file and re-read, so live cell edits aren't clobbered by the watcher reload.
        if (!(await flushNotebookDocumentIfDirty(fileUri))) {
            logger.warn(`persistProjectIntegrations: ${fileUri.path} — unsaved edits could not be saved`);

            return 'failed';
        }

        projectData = await readDeepnoteProjectFile(fileUri);

        // The flush may have saved a stale open document, swapping the on-disk project; re-validate before writing.
        if (projectData?.project?.id !== projectId) {
            return 'skipped';
        }

        // Rewrite ONLY integrations; every other field round-trips from disk, so saved cells are untouched.
        projectData.project.integrations = integrations;

        if (!projectData.metadata) {
            projectData.metadata = { createdAt: new Date().toISOString() };
        }

        projectData.metadata.modifiedAt = new Date().toISOString();

        await workspace.fs.writeFile(fileUri, new TextEncoder().encode(serializeDeepnoteFile(projectData)));

        return 'written';
    } catch (error) {
        logger.error(`persistProjectIntegrations: failed to update ${fileUri.path}`, error);

        return 'failed';
    }
}
