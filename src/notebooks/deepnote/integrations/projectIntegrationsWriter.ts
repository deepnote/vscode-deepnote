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

interface WriteSiblingFilesParams {
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

    const resolve: ResolveIntegrations = () => integrations;

    // Refresh the cache first so live env/kernel behavior stays correct even if a disk write fails.
    notebookManager.updateProjectIntegrations(projectId, integrations);

    // findFiles only covers open folders, so write the active file explicitly (no open folder / out-of-workspace).
    const writeOutcome = await writeIntegrationsToFile({ fileUri: activeFileUri, projectId, resolve });
    const siblingsFailed = await writeSiblingFiles({ activeFileUri, projectId, resolve });

    return { activePersisted: writeOutcome.status === 'written', siblingsFailed };
}

/**
 * Adds one integration to the project, merging into what each file holds instead of replacing the list: a caller
 * holding a snapshot across a prompt cannot delete entries written while it waited. An id already present is
 * replaced. The cache and the sibling sweep both follow the active file: neither runs until it is on disk.
 */
export async function addProjectIntegration(params: AddProjectIntegrationParams): Promise<PersistIntegrationsResult> {
    const { activeFileUri, integration, notebookManager, projectId } = params;
    const resolve: ResolveIntegrations = (existing) => [
        ...existing.filter((entry) => entry.id !== integration.id),
        integration
    ];

    const writeOutcome = await writeIntegrationsToFile({ fileUri: activeFileUri, projectId, resolve });

    // The active file is the mandate for the sweep. `skipped` means it is a snapshot or another project's file, and
    // `failed` means the add landed nowhere — stamping the project's other files on its behalf is data loss either way.
    if (writeOutcome.status !== 'written') {
        return { activePersisted: false, siblingsFailed: 0 };
    }

    // Before the sibling sweep, not after: saving a notebook rebuilds its whole file from the cached project, so a
    // cache still on the old roster would write the link straight back out mid-sweep.
    notebookManager.updateProjectIntegrations(projectId, writeOutcome.integrations);

    const siblingsFailed = await writeSiblingFiles({ activeFileUri, projectId, resolve });

    return { activePersisted: true, siblingsFailed };
}

/** Writes every discovered `.deepnote` of the project except `activeFileUri`; returns how many failed. */
async function writeSiblingFiles(params: WriteSiblingFilesParams): Promise<number> {
    const { activeFileUri, projectId, resolve } = params;

    const visited = new Set<string>([activeFileUri.toString()]);
    let siblingsFailed = 0;

    for (const workspaceFolder of workspace.workspaceFolders || []) {
        let files: Uri[];

        try {
            files = await workspace.findFiles(new RelativePattern(workspaceFolder, '**/*.deepnote'));
        } catch (error) {
            logger.error('projectIntegrationsWriter: failed to enumerate .deepnote files', error);

            continue;
        }

        for (const fileUri of files) {
            if (visited.has(fileUri.toString())) {
                continue;
            }

            visited.add(fileUri.toString());

            const writeOutcome = await writeIntegrationsToFile({ fileUri, projectId, resolve });
            if (writeOutcome.status === 'failed') {
                siblingsFailed++;
            }
        }
    }

    return siblingsFailed;
}

/** Writes one `.deepnote` file: `skipped` for a snapshot or another project, `written` carries what it now holds. */
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
            logger.warn(`projectIntegrationsWriter: ${fileUri.path} — unsaved edits could not be saved`);

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
        logger.error(`projectIntegrationsWriter: failed to update ${fileUri.path}`, error);

        return { status: 'failed' };
    }
}
