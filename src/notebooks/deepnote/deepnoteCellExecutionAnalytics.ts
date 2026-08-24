import { inject, injectable } from 'inversify';
import { Disposable, NotebookCellKind, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { ITelemetryService, TelemetryEventProperties } from '../../platform/analytics/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { isDeepnoteNotebook } from '../../platform/common/utils';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import {
    DATAFRAME_SQL_INTEGRATION_ID,
    toTelemetryIntegrationType
} from '../../platform/notebooks/deepnote/integrationTypes';
import { IDeepnoteNotebookManager } from '../types';
import { isEphemeralCell } from './dataConversionUtils';

/**
 * Tracks cell executions, plus the plain code/markdown insertions from VS Code's built-in
 * "+ Code" / "+ Markdown" controls that never reach an extension command, plus the scratch
 * cells the agent writes and runs on the user's behalf.
 */
@injectable()
export class DeepnoteCellExecutionAnalytics implements IExtensionSyncActivationService {
    constructor(
        @inject(ITelemetryService) private readonly analytics: ITelemetryService,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IDisposableRegistry) private readonly disposables: Disposable[]
    ) {}

    public activate(): void {
        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e) => {
                if (!isDeepnoteNotebook(e.notebook)) {
                    return;
                }

                for (const change of e.contentChanges) {
                    // Reload/replace paths (file-change watcher, remove-all-cells, input-block protection) all
                    // go through replaceCells, so a non-empty removedCells means this is not a user insertion.
                    if (change.removedCells.length > 0) {
                        continue;
                    }

                    for (const cell of change.addedCells) {
                        const blockType = cell.kind === NotebookCellKind.Code ? 'code' : 'markdown';

                        // Agent scratch cells stamp a pocket like any typed block, but no command
                        // inserts them, so this is the only place they can be counted.
                        if (isEphemeralCell(cell)) {
                            this.analytics.trackEvent({
                                eventName: 'add_block',
                                properties: { blockType, isEphemeral: true }
                            });
                            continue;
                        }

                        // Typed Deepnote blocks stamp a pocket on insert and are already counted by
                        // DeepnoteNotebookCommandListener.
                        if (cell.metadata?.__deepnotePocket?.type) {
                            continue;
                        }

                        this.analytics.trackEvent({
                            eventName: 'add_block',
                            properties: { blockType, isEphemeral: false }
                        });
                    }
                }
            })
        );

        this.disposables.push(
            notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                if (e.state !== NotebookCellExecutionState.Executing) {
                    return;
                }

                if (!isDeepnoteNotebook(e.cell.notebook)) {
                    return;
                }

                const languageId = e.cell.document.languageId;
                const cellType = languageId === 'sql' ? 'sql' : languageId === 'markdown' ? 'markdown' : 'code';

                // The agent runs its generated cells through `notebook.cell.execute`, which re-enters the
                // kernel path; unmarked they are indistinguishable here from a user pressing Run.
                const properties: TelemetryEventProperties['execute_cell'] = {
                    cellType,
                    isEphemeral: isEphemeralCell(e.cell)
                };

                if (cellType === 'sql') {
                    // The status-bar switch updates only this key, so the __deepnotePocket copy can go stale.
                    const integrationId = e.cell.metadata?.sql_integration_id;

                    if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
                        // A pseudo-id never present in project.integrations; 'duckdb' is what
                        // switch_sql_integration reports for it.
                        properties.integrationType = 'duckdb';
                    } else if (integrationId) {
                        const projectId = e.cell.notebook.metadata?.deepnoteProjectId;
                        const notebookId = e.cell.notebook.metadata?.deepnoteNotebookId;

                        if (projectId && notebookId) {
                            const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);
                            const integration = project?.project.integrations?.find((i) => i.id === integrationId);

                            if (integration?.type) {
                                properties.integrationType = toTelemetryIntegrationType(integration.type);
                            }
                        }
                    }
                }

                this.analytics.trackEvent({ eventName: 'execute_cell', properties });
            })
        );
    }
}
