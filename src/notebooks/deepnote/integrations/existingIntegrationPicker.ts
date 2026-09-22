import { CancellationToken, RelativePattern, Uri, workspace } from 'vscode';

import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import {
    ConfigurableDatabaseIntegrationType,
    isConfigurableDatabaseIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { IDeepnoteNotebookManager, ProjectIntegration, RawProjectIntegration } from '../../types';
import { isSnapshotFile } from '../snapshots/snapshotFiles';
import { PersistIntegrationsResult, persistProjectIntegrations } from './projectIntegrationsWriter';
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
    /** Stops the scan; the partial result is only fit to be discarded. */
    token?: CancellationToken;
}

export interface CollectReusableIntegrationsResult {
    /** The scan stopped early, so the other two fields are partial and must not be written anywhere. */
    cancelled: boolean;
    /**
     * Ids skipped because some project declares a type the stored config disagrees with: linking one would put a
     * type on this project that the credentials cannot back.
     */
    conflictingIds: string[];
    integrations: ReusableIntegration[];
}

export interface AttachExistingIntegrationParams {
    activeFileUri: Uri;
    /** The project's full integration list: every entry is written back verbatim, so a filtered array drops entries. */
    currentIntegrations: readonly RawProjectIntegration[];
    integration: ReusableIntegration;
    notebookManager: IDeepnoteNotebookManager;
    projectId: string;
}

/**
 * Scans every `.deepnote` file in the open workspace folders for integrations other projects declare.
 *
 * Reuse is a link, not a copy: `IntegrationStorage` and `FederatedAuthTokenStorage` both key configs by integration
 * id alone, so the project's own entry is the only thing that scopes an integration to a project.
 *
 * Integrations configured only in `.deepnote.env.yaml` are not offered: that file already applies to every project
 * under it, and the panel cannot write that layer.
 */
export async function collectReusableIntegrations(
    params: CollectReusableIntegrationsParams
): Promise<CollectReusableIntegrationsResult> {
    const { excludeIntegrationIds, integrationStorage, projectId, token } = params;

    const candidates = new Map<string, ReusableIntegration & { projectNameSet: Set<string> }>();
    const conflictingIds = new Set<string>();
    const visited = new Set<string>();

    for (const workspaceFolder of workspace.workspaceFolders || []) {
        if (token?.isCancellationRequested) {
            return { cancelled: true, conflictingIds: [], integrations: [] };
        }

        let files: Uri[];

        try {
            files = await workspace.findFiles(
                new RelativePattern(workspaceFolder, '**/*.deepnote'),
                undefined,
                undefined,
                token
            );
        } catch (error) {
            logger.error('collectReusableIntegrations: failed to enumerate .deepnote files', error);

            continue;
        }

        for (const fileUri of files) {
            if (token?.isCancellationRequested) {
                return { cancelled: true, conflictingIds: [], integrations: [] };
            }

            const key = fileUri.toString();

            if (visited.has(key) || isSnapshotFile(fileUri)) {
                continue;
            }

            visited.add(key);

            // One unreadable file must not hide every other project's integrations.
            try {
                const projectData = await readDeepnoteProjectFile(fileUri);

                if (!projectData?.project || projectData.project.id === projectId) {
                    continue;
                }

                const projectName = projectData.project.name || projectData.project.id;

                for (const entry of projectData.project.integrations ?? []) {
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
            } catch (error) {
                logger.error(`collectReusableIntegrations: failed to read ${fileUri.path}`, error);
            }
        }
    }

    // `workspace.findFiles` resolves empty when its token trips and the per-file awaits are not token-aware.
    if (token?.isCancellationRequested) {
        return { cancelled: true, conflictingIds: [], integrations: [] };
    }

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

    return { cancelled: false, conflictingIds: Array.from(conflictingIds).sort(), integrations };
}

/**
 * Links `integration` into the project's integrations through the same writer the panel uses, so the cache, the active
 * file and every sibling `.deepnote` file are updated together. Re-linking an id already there replaces its entry.
 */
export function attachExistingIntegration(params: AttachExistingIntegrationParams): Promise<PersistIntegrationsResult> {
    const { activeFileUri, currentIntegrations, integration, notebookManager, projectId } = params;

    const linked: ProjectIntegration = { id: integration.id, name: integration.name, type: integration.type };
    const integrations = [...currentIntegrations.filter((entry) => entry.id !== integration.id), linked];

    return persistProjectIntegrations({ activeFileUri, integrations, notebookManager, projectId });
}
