import type { DeepnoteFile } from '@deepnote/blocks';
import { CancellationToken, RelativePattern, Uri, workspace, WorkspaceFolder } from 'vscode';

import { Cancellation } from '../../../platform/common/cancellation';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import {
    ConfigurableDatabaseIntegrationType,
    isConfigurableDatabaseIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { isSnapshotFile } from '../snapshots/snapshotFiles';
import { addProjectIntegration, PersistIntegrationsResult } from './projectIntegrationsWriter';
import { IIntegrationStorage } from './types';

/** An integration another project in the workspace has credentials stored for, so linking it needs no re-entry. */
export interface ReusableIntegration {
    id: string;
    /** Name from the stored config — the same source the panel writes to the project integrations on save. */
    name: string;
    /** The other projects declaring this integration; deduped and sorted. */
    projectNames: string[];
    type: ConfigurableDatabaseIntegrationType;
}

export interface CollectReusableIntegrationsParams {
    /** Ids the current project already declares. */
    excludeIntegrationIds: ReadonlySet<string>;
    integrationStorage: IIntegrationStorage;
    /** The project being extended; its own `.deepnote` files are skipped. */
    projectId: string;
    /** Aborts the scan with a `CancellationError` rather than handing back a partial result. */
    token?: CancellationToken;
}

export interface CollectReusableIntegrationsResult {
    /**
     * Ids skipped because some project declares a type the stored config disagrees with: linking one would put a
     * type on this project that the credentials cannot back.
     */
    conflictingIds: string[];
    integrations: ReusableIntegration[];
}

export interface AttachExistingIntegrationParams {
    activeFileUri: Uri;
    integration: ReusableIntegration;
    notebookManager: IDeepnoteNotebookManager;
    projectId: string;
}

export interface FindOtherProjectsDeclaringParams {
    integrationId: string;
    /** The project asking; its own `.deepnote` files are skipped. */
    projectId: string;
}

type OtherProjectFileVisitor = (project: DeepnoteFile['project'], fileUri: Uri) => Promise<void> | void;

/**
 * Scans every `.deepnote` file in the open workspace folders for integrations other projects declare.
 *
 * Reuse is a link, not a copy: `IntegrationStorage` and `FederatedAuthTokenStorage` both key configs by integration
 * id alone, so the project's own entry is the only thing that scopes an integration to a project.
 *
 * Integrations configured only in `.deepnote.env.yaml` are not offered: that file already applies to every project
 * under it, and the panel cannot write that layer.
 *
 * @throws `CancellationError` when `token` trips, so a half-finished scan can never be mistaken for a complete one.
 */
export async function collectReusableIntegrations(
    params: CollectReusableIntegrationsParams
): Promise<CollectReusableIntegrationsResult> {
    const { excludeIntegrationIds, integrationStorage, projectId, token } = params;

    const candidates = new Map<string, ReusableIntegration & { projectNameSet: Set<string> }>();
    const conflictingIds = new Set<string>();

    await forEachOtherProjectFile(projectId, token, async (project, fileUri) => {
        const projectName = project.name || project.id;

        for (const entry of project.integrations ?? []) {
            if (excludeIntegrationIds.has(entry.id) || !isConfigurableDatabaseIntegrationType(entry.type)) {
                continue;
            }

            const storedConfig = await integrationStorage.getIntegrationConfig(entry.id);

            if (!storedConfig) {
                // File-only or never configured — no stored credentials to reuse.
                continue;
            }

            if (storedConfig.type !== entry.type) {
                logger.warn(
                    `collectReusableIntegrations: ${entry.id} is declared as ${entry.type} in ${fileUri.path} but stored as ${storedConfig.type}; skipping`
                );
                conflictingIds.add(entry.id);

                continue;
            }

            const existing = candidates.get(entry.id);

            if (existing) {
                existing.projectNameSet.add(projectName);
            } else {
                candidates.set(entry.id, {
                    id: entry.id,
                    name: storedConfig.name || entry.name || entry.id,
                    projectNameSet: new Set([projectName]),
                    projectNames: [],
                    type: storedConfig.type
                });
            }
        }
    });

    // A conflict in any project disqualifies the id everywhere: the stored config is the single shared truth.
    for (const id of conflictingIds) {
        candidates.delete(id);
    }

    const integrations = Array.from(candidates.values())
        .map(({ projectNameSet, ...candidate }) => ({
            ...candidate,
            projectNames: Array.from(projectNameSet).sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    return { conflictingIds: Array.from(conflictingIds).sort(), integrations };
}

/**
 * Links `integration` into the project's integrations through the same writer the panel uses, so the cache, the active
 * file and every sibling `.deepnote` file are updated together. Re-linking an id already there replaces its entry.
 */
export function attachExistingIntegration(params: AttachExistingIntegrationParams): Promise<PersistIntegrationsResult> {
    const { activeFileUri, integration, notebookManager, projectId } = params;

    const linked: ProjectIntegration = { id: integration.id, name: integration.name, type: integration.type };

    return addProjectIntegration({ activeFileUri, integration: linked, notebookManager, projectId });
}

/**
 * Names of the other projects in the open workspace folders whose `.deepnote` files declare `integrationId`, deduped
 * and sorted; empty when none does. Only open folders are scanned, while SecretStorage is shared machine-wide.
 */
export async function findOtherProjectsDeclaring(params: FindOtherProjectsDeclaringParams): Promise<string[]> {
    const { integrationId, projectId } = params;
    const projectNames = new Set<string>();

    await forEachOtherProjectFile(projectId, undefined, (project) => {
        if (project.integrations?.some((entry) => entry.id === integrationId)) {
            projectNames.add(project.name || project.id);
        }
    });

    return Array.from(projectNames).sort((a, b) => a.localeCompare(b));
}

/** A folder that cannot be enumerated contributes no files instead of ending the walk. */
async function findDeepnoteFiles(
    workspaceFolder: WorkspaceFolder,
    token: CancellationToken | undefined
): Promise<Uri[]> {
    try {
        return await workspace.findFiles(
            new RelativePattern(workspaceFolder, '**/*.deepnote'),
            undefined,
            undefined,
            token
        );
    } catch (error) {
        logger.error('existingIntegrationPicker: failed to enumerate .deepnote files', error);

        return [];
    }
}

/**
 * Visits each `.deepnote` file in the open workspace folders that belongs to a project other than `projectId`, once;
 * snapshots are skipped.
 *
 * @throws `CancellationError` when `token` trips, including once the last file has been visited.
 */
async function forEachOtherProjectFile(
    projectId: string,
    token: CancellationToken | undefined,
    visit: OtherProjectFileVisitor
): Promise<void> {
    const visited = new Set<string>();

    for (const workspaceFolder of workspace.workspaceFolders || []) {
        Cancellation.throwIfCanceled(token);

        for (const fileUri of await findDeepnoteFiles(workspaceFolder, token)) {
            Cancellation.throwIfCanceled(token);

            const key = fileUri.toString();

            if (visited.has(key) || isSnapshotFile(fileUri)) {
                continue;
            }

            visited.add(key);
            await visitOtherProjectFile(fileUri, projectId, visit);
        }
    }

    // `workspace.findFiles` resolves empty when its token trips and the per-file awaits are not token-aware.
    Cancellation.throwIfCanceled(token);
}

/** `visit` runs inside the per-file catch: a visitor that throws costs only this file, like a failed read. */
async function visitOtherProjectFile(fileUri: Uri, projectId: string, visit: OtherProjectFileVisitor): Promise<void> {
    // One unreadable file must not hide every other project's integrations.
    try {
        const projectData = await readDeepnoteProjectFile(fileUri);

        if (!projectData?.project || projectData.project.id === projectId) {
            return;
        }

        await visit(projectData.project, fileUri);
    } catch (error) {
        logger.error(`existingIntegrationPicker: failed to read ${fileUri.path}`, error);
    }
}
