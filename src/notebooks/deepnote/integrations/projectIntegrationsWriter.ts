import { serializeDeepnoteFile } from '@deepnote/blocks';
import { RelativePattern, Uri, workspace } from 'vscode';

import { flushNotebookDocumentIfDirty } from '../../../platform/deepnote/deepnoteDocumentFlush';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import { IDeepnoteNotebookManager, RawProjectIntegration } from '../../types';
import { isSnapshotFile } from '../snapshots/snapshotFiles';

export interface PersistIntegrationsResult {
    activePersisted: boolean;
    siblingsFailed: number;
}

export interface PersistProjectIntegrationsParams {
    notebookManager: IDeepnoteNotebookManager;
    projectId: string;
    integrations: RawProjectIntegration[];
    activeFileUri: Uri;
}

export interface AddProjectIntegrationParams {
    activeFileUri: Uri;
    integration: RawProjectIntegration;
    notebookManager: IDeepnoteNotebookManager;
    projectId: string;
}

interface WriteProjectFilesParams {
    activeFileUri: Uri;
    projectId: string;
    resolve: ResolveIntegrations;
}

interface WriteIntegrationsToFileParams {
    fileUri: Uri;
    projectId: string;
    resolve: ResolveIntegrations;
}

/** Builds the array to write from the one the file holds, read a step earlier in the same function. */
type ResolveIntegrations = (existing: RawProjectIntegration[]) => RawProjectIntegration[];

type IntegrationWriteOutcome =
    | { status: 'failed' | 'skipped' }
    | { status: 'written'; integrations: RawProjectIntegration[] };

/** Writes `integrations` to the active file and every on-disk sibling; `activePersisted` reflects disk truth, not the cache. */
export async function persistProjectIntegrations(
    params: PersistProjectIntegrationsParams
): Promise<PersistIntegrationsResult> {
    const { notebookManager, projectId, integrations, activeFileUri } = params;

    // Refresh the cache first so live env/kernel behavior stays correct even if a disk write fails.
    notebookManager.updateProjectIntegrations(projectId, integrations);

    const { active, siblingsFailed } = await writeProjectFiles({
        activeFileUri,
        projectId,
        resolve: () => integrations
    });

    return { activePersisted: active.status === 'written', siblingsFailed };
}

/**
 * Adds one integration to the project, merging into what each file holds instead of replacing the list: a caller
 * holding a snapshot across a prompt cannot delete entries written while it waited. An id already present is
 * replaced. The cache follows the active file and moves only once that file is on disk.
 */
export async function addProjectIntegration(params: AddProjectIntegrationParams): Promise<PersistIntegrationsResult> {
    const { activeFileUri, integration, notebookManager, projectId } = params;

    const { active, siblingsFailed } = await writeProjectFiles({
        activeFileUri,
        projectId,
        resolve: (existing) => [...existing.filter((entry) => entry.id !== integration.id), integration]
    });

    if (active.status !== 'written') {
        return { activePersisted: false, siblingsFailed };
    }

    notebookManager.updateProjectIntegrations(projectId, active.integrations);

    return { activePersisted: true, siblingsFailed };
}

async function writeProjectFiles(
    params: WriteProjectFilesParams
): Promise<{ active: IntegrationWriteOutcome; siblingsFailed: number }> {
    const { activeFileUri, projectId, resolve } = params;

    // findFiles only covers open folders, so write the active file explicitly (no open folder / out-of-workspace).
    const active = await writeIntegrationsToFile({ fileUri: activeFileUri, projectId, resolve });

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

            if ((await writeIntegrationsToFile({ fileUri, projectId, resolve })).status === 'failed') {
                siblingsFailed++;
            }
        }
    }

    return { active, siblingsFailed };
}

/** Returns `'skipped'` (snapshot / other project), `'failed'`, or `'written'` for one `.deepnote` file. */
async function writeIntegrationsToFile(params: WriteIntegrationsToFileParams): Promise<IntegrationWriteOutcome> {
    const { fileUri, projectId, resolve } = params;

    if (isSnapshotFile(fileUri)) {
        return { status: 'skipped' };
    }

    try {
        let projectData = await readDeepnoteProjectFile(fileUri);

        if (projectData?.project?.id !== projectId) {
            return { status: 'skipped' };
        }

        // Flush an open dirty file and re-read, so live cell edits aren't clobbered by the watcher reload.
        if (!(await flushNotebookDocumentIfDirty(fileUri))) {
            logger.warn(`persistProjectIntegrations: ${fileUri.path} — unsaved edits could not be saved`);

            return { status: 'failed' };
        }

        projectData = await readDeepnoteProjectFile(fileUri);

        // The flush may have saved a stale open document, swapping the on-disk project; re-validate before writing.
        if (projectData?.project?.id !== projectId) {
            return { status: 'skipped' };
        }

        // Rewrite ONLY integrations; every other field round-trips from disk, so saved cells are untouched.
        const integrations = resolve(projectData.project.integrations ?? []);

        projectData.project.integrations = integrations;

        if (!projectData.metadata) {
            projectData.metadata = { createdAt: new Date().toISOString() };
        }

        projectData.metadata.modifiedAt = new Date().toISOString();

        await workspace.fs.writeFile(fileUri, new TextEncoder().encode(serializeDeepnoteFile(projectData)));

        return { integrations, status: 'written' };
    } catch (error) {
        logger.error(`persistProjectIntegrations: failed to update ${fileUri.path}`, error);

        return { status: 'failed' };
    }
}
