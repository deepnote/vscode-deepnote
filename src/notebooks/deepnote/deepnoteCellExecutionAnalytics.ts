import { inject, injectable } from 'inversify';
import { Disposable } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { ITelemetryService } from '../../platform/analytics/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { isDeepnoteNotebook } from '../../platform/common/utils';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { DATAFRAME_SQL_INTEGRATION_ID } from '../../platform/notebooks/deepnote/integrationTypes';
import { IDeepnoteNotebookManager } from '../types';

/**
 * Tracks cell execution events for telemetry.
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
            notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                if (e.state !== NotebookCellExecutionState.Executing) {
                    return;
                }

                if (!isDeepnoteNotebook(e.cell.notebook)) {
                    return;
                }

                const languageId = e.cell.document.languageId;
                const cellType = languageId === 'sql' ? 'sql' : languageId === 'markdown' ? 'markdown' : 'code';

                const properties: { cellType: 'sql' | 'markdown' | 'code'; integrationType?: string } = { cellType };

                if (cellType === 'sql') {
                    // Read the authoritative top-level key only; the status-bar switch updates only this
                    // key (the __deepnotePocket copy can go stale after an in-session integration switch).
                    const integrationId = e.cell.metadata?.sql_integration_id;

                    if (integrationId === DATAFRAME_SQL_INTEGRATION_ID) {
                        // The built-in DataFrame SQL integration is a pseudo-id never present in
                        // project.integrations; map it the same way switch_sql_integration does.
                        properties.integrationType = 'duckdb';
                    } else if (integrationId) {
                        const projectId = e.cell.notebook.metadata?.deepnoteProjectId;
                        const notebookId = e.cell.notebook.metadata?.deepnoteNotebookId;

                        if (projectId && notebookId) {
                            const project = this.notebookManager.getProjectForNotebook(projectId, notebookId);
                            const integration = project?.project.integrations?.find((i) => i.id === integrationId);

                            if (integration?.type) {
                                properties.integrationType = integration.type;
                            }
                        }
                    }
                }

                this.analytics.trackEvent({ eventName: 'execute_cell', properties });
            })
        );
    }
}
