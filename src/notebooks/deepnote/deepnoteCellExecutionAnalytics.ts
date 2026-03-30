import { inject, injectable } from 'inversify';
import { Disposable } from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { ITelemetryService } from '../../platform/analytics/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
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

                if (e.cell.notebook.notebookType !== 'deepnote') {
                    return;
                }

                const languageId = e.cell.document.languageId;
                const cellType = languageId === 'sql' ? 'sql' : languageId === 'markdown' ? 'markdown' : 'code';

                const properties: Record<string, string> = { cellType };

                if (cellType === 'sql') {
                    const integrationId =
                        e.cell.metadata?.__deepnotePocket?.sql_integration_id ?? e.cell.metadata?.sql_integration_id;

                    if (integrationId) {
                        const projectId = e.cell.notebook.metadata?.deepnoteProjectId;

                        if (projectId) {
                            const project = this.notebookManager.getOriginalProject(projectId);
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
