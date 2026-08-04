import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import {
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellKind,
    NotebookDocument,
    NotebookDocumentChangeEvent,
    Uri
} from 'vscode';

import { ITelemetryService } from '../../platform/analytics/types';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { DATAFRAME_SQL_INTEGRATION_ID } from '../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteCellExecutionAnalytics } from './deepnoteCellExecutionAnalytics';
import { IDeepnoteNotebookManager } from '../types';

suite('DeepnoteCellExecutionAnalytics', () => {
    let telemetry: ITelemetryService;
    let notebookManager: IDeepnoteNotebookManager;
    let disposables: Disposable[];
    let onDidChangeNotebookDocument: EventEmitter<NotebookDocumentChangeEvent>;

    const JUPYTER = 'jupyter-notebook';

    function addedCell(kind: NotebookCellKind, pocketType?: string): NotebookCell {
        return {
            kind,
            metadata: pocketType ? { __deepnotePocket: { type: pocketType } } : {}
        } as unknown as NotebookCell;
    }

    function executingCell(languageId: string, sqlIntegrationId?: string, notebookType = 'deepnote'): NotebookCell {
        return {
            document: { languageId },
            kind: NotebookCellKind.Code,
            metadata: sqlIntegrationId ? { sql_integration_id: sqlIntegrationId } : {},
            notebook: {
                metadata: { deepnoteNotebookId: 'notebook-1', deepnoteProjectId: 'project-1' },
                notebookType,
                uri: Uri.file('/ws/p.deepnote')
            }
        } as unknown as NotebookCell;
    }

    function fireContentChange(added: NotebookCell[], removed: NotebookCell[], notebookType = 'deepnote'): void {
        onDidChangeNotebookDocument.fire({
            notebook: { notebookType, uri: Uri.file('/ws/p.deepnote') } as NotebookDocument,
            metadata: undefined,
            cellChanges: [],
            contentChanges: [{ range: undefined, addedCells: added, removedCells: removed }]
        } as unknown as NotebookDocumentChangeEvent);
    }

    function stubProjectIntegrations(integrations: Array<{ id: string; name: string; type: string }>): void {
        when(notebookManager.getProjectForNotebook('project-1', 'notebook-1')).thenReturn({
            project: { integrations }
        } as never);
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [];
        onDidChangeNotebookDocument = new EventEmitter<NotebookDocumentChangeEvent>();
        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument).thenReturn(
            onDidChangeNotebookDocument.event
        );

        telemetry = mock<ITelemetryService>();
        notebookManager = mock<IDeepnoteNotebookManager>();
        new DeepnoteCellExecutionAnalytics(instance(telemetry), instance(notebookManager), disposables).activate();
    });

    teardown(() => {
        onDidChangeNotebookDocument.dispose();
        disposables.forEach((d) => d.dispose());
        resetVSCodeMocks();
    });

    suite('add_block', () => {
        (
            [
                {
                    // Typed blocks are already counted by DeepnoteNotebookCommandListener.
                    name: 'counts the untyped cells of an insertion, by kind',
                    added: [
                        addedCell(NotebookCellKind.Code, 'sql'),
                        addedCell(NotebookCellKind.Code),
                        addedCell(NotebookCellKind.Markup)
                    ],
                    removed: [],
                    expected: ['code', 'markdown']
                },
                {
                    // Reload/replace paths rebuild cells without a pocket, so removedCells is the only signal.
                    name: 'a replace is not an insertion',
                    added: [addedCell(NotebookCellKind.Code), addedCell(NotebookCellKind.Markup)],
                    removed: [addedCell(NotebookCellKind.Code), addedCell(NotebookCellKind.Markup)],
                    expected: []
                }
            ] as const
        ).forEach((row) => {
            test(row.name, () => {
                fireContentChange([...row.added], [...row.removed]);

                row.expected.forEach((blockType) =>
                    verify(
                        telemetry.trackEvent(deepEqual({ eventName: 'add_block', properties: { blockType } }))
                    ).once()
                );
                verify(telemetry.trackEvent(anything())).times(row.expected.length);
            });
        });

        test('ignores non-Deepnote notebooks', () => {
            fireContentChange([addedCell(NotebookCellKind.Code)], [], JUPYTER);

            verify(telemetry.trackEvent(anything())).never();
        });
    });

    suite('execute_cell', () => {
        const rows: Array<{
            name: string;
            languageId: string;
            integrationId?: string;
            integrations?: Array<{ id: string; name: string; type: string }>;
            expected: { cellType: 'sql' | 'markdown' | 'code'; integrationType?: string };
        }> = [
            { name: 'python cell reports cellType code', languageId: 'python', expected: { cellType: 'code' } },
            {
                name: 'the DataFrame SQL pseudo-integration maps to duckdb',
                languageId: 'sql',
                integrationId: DATAFRAME_SQL_INTEGRATION_ID,
                expected: { cellType: 'sql', integrationType: 'duckdb' }
            },
            {
                name: 'a project integration id resolves to its type',
                languageId: 'sql',
                integrationId: 'int-1',
                integrations: [{ id: 'int-1', name: 'PG', type: 'pgsql' }],
                expected: { cellType: 'sql', integrationType: 'pgsql' }
            },
            {
                // integrations[].type is a free-form string in the .deepnote schema.
                name: 'an unrecognized integration type reports unknown',
                languageId: 'sql',
                integrationId: 'int-1',
                integrations: [{ id: 'int-1', name: 'X', type: 'not-a-real-integration-type' }],
                expected: { cellType: 'sql', integrationType: 'unknown' }
            },
            {
                name: 'an id absent from the project omits integrationType',
                languageId: 'sql',
                integrationId: 'gone',
                integrations: [],
                expected: { cellType: 'sql' }
            }
        ];

        rows.forEach((row) => {
            test(row.name, () => {
                if (row.integrations) {
                    stubProjectIntegrations(row.integrations);
                }

                notebookCellExecutions.changeCellState(
                    executingCell(row.languageId, row.integrationId),
                    NotebookCellExecutionState.Executing
                );

                verify(
                    telemetry.trackEvent(deepEqual({ eventName: 'execute_cell', properties: { ...row.expected } }))
                ).once();
                verify(telemetry.trackEvent(anything())).once();
            });
        });

        test('ignores Pending and Idle transitions, and non-Deepnote notebooks', () => {
            const cell = executingCell('python');

            notebookCellExecutions.changeCellState(cell, NotebookCellExecutionState.Pending);
            notebookCellExecutions.changeCellState(cell, NotebookCellExecutionState.Idle);
            notebookCellExecutions.changeCellState(
                executingCell('python', undefined, JUPYTER),
                NotebookCellExecutionState.Executing
            );

            verify(telemetry.trackEvent(anything())).never();
        });
    });
});
