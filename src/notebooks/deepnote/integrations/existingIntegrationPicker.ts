import type { DeepnoteFile } from '@deepnote/blocks';
import { RelativePattern, Uri, workspace } from 'vscode';

import * as localize from '../../../platform/common/utils/localize';
import { readDeepnoteProjectFile } from '../../../platform/deepnote/deepnoteProjectFileReader';
import { logger } from '../../../platform/logging';
import {
    ConfigurableDatabaseIntegrationType,
    isConfigurableDatabaseIntegrationType
} from '../../../platform/notebooks/deepnote/integrationTypes';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { isSnapshotFile } from '../snapshots/snapshotFiles';
import { PersistIntegrationsResult, persistProjectIntegrations } from './projectIntegrationsWriter';
import { IIntegrationStorage } from './types';

/** Human-readable type labels for the picker; mirrors `integrationTypeLabels` in the webview bundle. */
const INTEGRATION_TYPE_LABELS: Record<ConfigurableDatabaseIntegrationType, string> = {
    alloydb: localize.Integrations.alloyDBTypeLabel,
    athena: localize.Integrations.athenaTypeLabel,
    'big-query': localize.Integrations.bigQueryTypeLabel,
    clickhouse: localize.Integrations.clickHouseTypeLabel,
    'cloud-sql': localize.Integrations.cloudSqlTypeLabel,
    databricks: localize.Integrations.databricksTypeLabel,
    dremio: localize.Integrations.dremioTypeLabel,
    mariadb: localize.Integrations.mariaDBTypeLabel,
    materialize: localize.Integrations.materializeTypeLabel,
    mindsdb: localize.Integrations.mindsDBTypeLabel,
    mongodb: localize.Integrations.mongoDBTypeLabel,
    mysql: localize.Integrations.mySQLTypeLabel,
    pgsql: localize.Integrations.postgresTypeLabel,
    redshift: localize.Integrations.redshiftTypeLabel,
    snowflake: localize.Integrations.snowflakeTypeLabel,
    spanner: localize.Integrations.spannerTypeLabel,
    'sql-server': localize.Integrations.sqlServerTypeLabel,
    trino: localize.Integrations.trinoTypeLabel
};

export function integrationTypeLabel(type: ConfigurableDatabaseIntegrationType): string {
    return INTEGRATION_TYPE_LABELS[type] ?? type;
}

/** A roster entry exactly as the `.deepnote` file records it; `type` is not narrowed to the types this build knows. */
export type RawProjectIntegration = NonNullable<DeepnoteFile['project']['integrations']>[number];

/**
 * A SecretStorage integration declared by at least one *other* project in the workspace, so it can be linked into
 * the current project without re-entering credentials.
 */
export interface ReusableIntegration {
    id: string;
    /** Name from the stored config — the same source the panel writes to the roster on save. */
    name: string;
    /** Display names of the other projects whose roster declares this integration; deduped and sorted. */
    projectNames: string[];
    type: ConfigurableDatabaseIntegrationType;
}

export interface CollectReusableIntegrationsParams {
    /** Integration ids already on the current project's roster; never offered again. */
    excludeIntegrationIds: ReadonlySet<string>;
    integrationStorage: IIntegrationStorage;
    /** The project being extended; its own `.deepnote` files are skipped. */
    projectId: string;
}

export interface CollectReusableIntegrationsResult {
    /**
     * Ids skipped because a project's roster declares the integration with a type that differs from the stored
     * configuration. Linking such an entry would put a roster type on this project that the credentials cannot
     * back, so the caller warns instead.
     */
    conflictingIds: string[];
    integrations: ReusableIntegration[];
}

export interface AttachExistingIntegrationParams {
    activeFileUri: Uri;
    /**
     * The current project's roster exactly as cached by the notebook manager. Every entry passes through to the
     * write verbatim (including `pandas-dataframe` and any type this build does not know), so nothing is pruned.
     */
    currentIntegrations: readonly RawProjectIntegration[];
    integration: ReusableIntegration;
    notebookManager: IDeepnoteNotebookManager;
    projectId: string;
}

/**
 * Scans every `.deepnote` file in the open workspace folders and collects the SecretStorage integrations other
 * projects declare.
 *
 * Storage design: `IntegrationStorage` keys configs by integration id alone (there is no per-project namespace),
 * and both the env-var provider and the detector resolve credentials from the project roster
 * (`project.integrations[].id`). The roster entry is therefore the only thing that "attaches" an integration to a
 * project, and reusing one is a pure link: no config is copied. Federated (`google-oauth`) integrations are
 * included for the same reason — `FederatedAuthTokenStorage` is also keyed by integration id, and the per-cell
 * code generator resolves the config through the roster of the notebook being run.
 *
 * Integrations configured only in `.deepnote.env.yaml` (no stored config) are not offered: that file already
 * applies to every project under it, and the panel cannot write that layer.
 */
export async function collectReusableIntegrations(
    params: CollectReusableIntegrationsParams
): Promise<CollectReusableIntegrationsResult> {
    const { excludeIntegrationIds, integrationStorage, projectId } = params;

    const candidates = new Map<string, ReusableIntegration & { projectNameSet: Set<string> }>();
    const conflictingIds = new Set<string>();
    const visited = new Set<string>();

    for (const workspaceFolder of workspace.workspaceFolders || []) {
        let files: Uri[];

        try {
            files = await workspace.findFiles(new RelativePattern(workspaceFolder, '**/*.deepnote'));
        } catch (error) {
            logger.error('collectReusableIntegrations: failed to enumerate .deepnote files', error);

            continue;
        }

        for (const fileUri of files) {
            const key = fileUri.toString();

            if (visited.has(key) || isSnapshotFile(fileUri)) {
                continue;
            }

            visited.add(key);

            // Per-file try/catch: one unreadable file must not hide every other project's integrations.
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
                        // File-only or never-configured: there are no credentials in SecretStorage to reuse.
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
 * Links `integration` into the project's roster and persists it through the same writer the panel uses, so the
 * cache, the active file and every sibling `.deepnote` file of the project are updated together. Idempotent for an
 * id already on the roster (the entry is replaced, not duplicated).
 */
export function attachExistingIntegration(params: AttachExistingIntegrationParams): Promise<PersistIntegrationsResult> {
    const { activeFileUri, currentIntegrations, integration, notebookManager, projectId } = params;

    const linked: ProjectIntegration = { id: integration.id, name: integration.name, type: integration.type };
    // Cast rather than narrow: validating the existing entries would silently drop any type this build does not
    // know about (`pandas-dataframe` included), which is pruning by another name.
    const integrations = [
        ...currentIntegrations.filter((entry) => entry.id !== integration.id),
        linked
    ] as ProjectIntegration[];

    return persistProjectIntegrations({ activeFileUri, integrations, notebookManager, projectId });
}
