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

suite('DeepnoteCellExecutionAnalytics - add_block', () => {
    let analytics: DeepnoteCellExecutionAnalytics;
    let mockTelemetryService: ITelemetryService;
    let mockNotebookManager: IDeepnoteNotebookManager;
    let disposables: Disposable[];
    let onDidChangeNotebookDocument: EventEmitter<NotebookDocumentChangeEvent>;

    const deepnoteNotebook = { notebookType: 'deepnote', uri: Uri.file('/ws/p.deepnote') } as NotebookDocument;

    function cell(kind: NotebookCellKind, metadata: Record<string, unknown> = {}): NotebookCell {
        return { kind, metadata } as unknown as NotebookCell;
    }

    /** Fire a single content change with the given added/removed cells. */
    function fireChange(
        added: NotebookCell[],
        removed: NotebookCell[] = [],
        notebook: NotebookDocument = deepnoteNotebook
    ): void {
        onDidChangeNotebookDocument.fire({
            notebook,
            metadata: undefined,
            cellChanges: [],
            contentChanges: [{ range: undefined, addedCells: added, removedCells: removed }]
        } as unknown as NotebookDocumentChangeEvent);
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [];
        onDidChangeNotebookDocument = new EventEmitter<NotebookDocumentChangeEvent>();
        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument).thenReturn(
            onDidChangeNotebookDocument.event
        );

        mockTelemetryService = mock<ITelemetryService>();
        mockNotebookManager = mock<IDeepnoteNotebookManager>();
        analytics = new DeepnoteCellExecutionAnalytics(
            instance(mockTelemetryService),
            instance(mockNotebookManager),
            disposables
        );
        analytics.activate();
    });

    teardown(() => {
        onDidChangeNotebookDocument.dispose();
        disposables.forEach((d) => d.dispose());
        resetVSCodeMocks();
    });

    test('tracks a plain code cell inserted by the built-in "+ Code" affordance', () => {
        fireChange([cell(NotebookCellKind.Code)]);

        verify(
            mockTelemetryService.trackEvent(deepEqual({ eventName: 'add_block', properties: { blockType: 'code' } }))
        ).once();
        verify(mockTelemetryService.trackEvent(anything())).once();
    });

    test('tracks a plain markdown cell as markdown', () => {
        fireChange([cell(NotebookCellKind.Markup)]);

        verify(
            mockTelemetryService.trackEvent(
                deepEqual({ eventName: 'add_block', properties: { blockType: 'markdown' } })
            )
        ).once();
    });

    test('does not double-count typed Deepnote blocks, which the command listener already tracks', () => {
        fireChange([cell(NotebookCellKind.Code, { __deepnotePocket: { type: 'sql' } })]);

        verify(mockTelemetryService.trackEvent(anything())).never();
    });

    test('counts only the untyped cells in a mixed insertion', () => {
        fireChange([
            cell(NotebookCellKind.Code, { __deepnotePocket: { type: 'visualization' } }),
            cell(NotebookCellKind.Code)
        ]);

        verify(
            mockTelemetryService.trackEvent(deepEqual({ eventName: 'add_block', properties: { blockType: 'code' } }))
        ).once();
        verify(mockTelemetryService.trackEvent(anything())).once();
    });

    test('ignores a full-notebook reload, which replaces rather than inserts cells', () => {
        // DeepnoteFileChangeWatcher rebuilds every cell via replaceCells on an external file change;
        // the rebuilt cells carry no pocket, so removedCells is the only thing separating this from
        // a user insertion.
        const rebuilt = [cell(NotebookCellKind.Code), cell(NotebookCellKind.Code), cell(NotebookCellKind.Markup)];

        fireChange(rebuilt, [cell(NotebookCellKind.Code), cell(NotebookCellKind.Code), cell(NotebookCellKind.Markup)]);

        verify(mockTelemetryService.trackEvent(anything())).never();
    });

    test('ignores a single-cell replace (input-block protection, watcher fallback)', () => {
        fireChange([cell(NotebookCellKind.Code)], [cell(NotebookCellKind.Code)]);

        verify(mockTelemetryService.trackEvent(anything())).never();
    });

    test('ignores insertions into non-Deepnote notebooks', () => {
        fireChange([cell(NotebookCellKind.Code)], [], {
            notebookType: 'jupyter-notebook',
            uri: Uri.file('/ws/p.ipynb')
        } as NotebookDocument);

        verify(mockTelemetryService.trackEvent(anything())).never();
    });
});

suite('DeepnoteCellExecutionAnalytics - execute_cell', () => {
    let analytics: DeepnoteCellExecutionAnalytics;
    let mockTelemetryService: ITelemetryService;
    let mockNotebookManager: IDeepnoteNotebookManager;
    let disposables: Disposable[];

    function executingCell(options: {
        languageId: string;
        cellMetadata?: Record<string, unknown>;
        notebookType?: string;
    }): NotebookCell {
        return {
            document: { languageId: options.languageId },
            kind: NotebookCellKind.Code,
            metadata: options.cellMetadata ?? {},
            notebook: {
                metadata: { deepnoteNotebookId: 'notebook-1', deepnoteProjectId: 'project-1' },
                notebookType: options.notebookType ?? 'deepnote',
                uri: Uri.file('/ws/p.deepnote')
            }
        } as unknown as NotebookCell;
    }

    /** Drive the real singleton the service subscribes to, as the execution machinery does. */
    function fireExecutionState(cell: NotebookCell, state: NotebookCellExecutionState): void {
        notebookCellExecutions.changeCellState(cell, state);
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [];

        // activate() also subscribes to onDidChangeNotebookDocument for add_block; park it on a
        // throwaway emitter so only the execution-state listener is exercised here.
        const changeEmitter = new EventEmitter<NotebookDocumentChangeEvent>();
        disposables.push(changeEmitter);
        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument).thenReturn(changeEmitter.event);

        mockTelemetryService = mock<ITelemetryService>();
        mockNotebookManager = mock<IDeepnoteNotebookManager>();
        analytics = new DeepnoteCellExecutionAnalytics(
            instance(mockTelemetryService),
            instance(mockNotebookManager),
            disposables
        );
        analytics.activate();
    });

    teardown(() => {
        disposables.forEach((d) => d.dispose());
        resetVSCodeMocks();
    });

    test('tracks a python cell entering the Executing state as cellType code', () => {
        fireExecutionState(executingCell({ languageId: 'python' }), NotebookCellExecutionState.Executing);

        verify(
            mockTelemetryService.trackEvent(deepEqual({ eventName: 'execute_cell', properties: { cellType: 'code' } }))
        ).once();
        verify(mockTelemetryService.trackEvent(anything())).once();
    });

    test('does not track Pending or Idle state changes', () => {
        const cell = executingCell({ languageId: 'python' });

        fireExecutionState(cell, NotebookCellExecutionState.Pending);
        fireExecutionState(cell, NotebookCellExecutionState.Idle);

        verify(mockTelemetryService.trackEvent(anything())).never();
    });

    test('does not track executions in non-Deepnote notebooks', () => {
        fireExecutionState(
            executingCell({ languageId: 'python', notebookType: 'jupyter-notebook' }),
            NotebookCellExecutionState.Executing
        );

        verify(mockTelemetryService.trackEvent(anything())).never();
    });

    test('maps the built-in DataFrame SQL pseudo-integration to duckdb', () => {
        fireExecutionState(
            executingCell({ cellMetadata: { sql_integration_id: DATAFRAME_SQL_INTEGRATION_ID }, languageId: 'sql' }),
            NotebookCellExecutionState.Executing
        );

        verify(
            mockTelemetryService.trackEvent(
                deepEqual({ eventName: 'execute_cell', properties: { cellType: 'sql', integrationType: 'duckdb' } })
            )
        ).once();
        verify(mockTelemetryService.trackEvent(anything())).once();
    });

    test('resolves a project integration id to its integration type', () => {
        when(mockNotebookManager.getProjectForNotebook('project-1', 'notebook-1')).thenReturn({
            project: { integrations: [{ id: 'int-1', name: 'PG', type: 'pgsql' }] }
        } as never);

        fireExecutionState(
            executingCell({ cellMetadata: { sql_integration_id: 'int-1' }, languageId: 'sql' }),
            NotebookCellExecutionState.Executing
        );

        verify(
            mockTelemetryService.trackEvent(
                deepEqual({ eventName: 'execute_cell', properties: { cellType: 'sql', integrationType: 'pgsql' } })
            )
        ).once();
        verify(mockTelemetryService.trackEvent(anything())).once();
    });

    test('reports an unrecognized project integration type as unknown', () => {
        // integrations[].type is a free-form string in the .deepnote schema; unbounded values must
        // not reach analytics verbatim.
        when(mockNotebookManager.getProjectForNotebook('project-1', 'notebook-1')).thenReturn({
            project: { integrations: [{ id: 'int-1', name: 'X', type: 'not-a-real-integration-type' }] }
        } as never);

        fireExecutionState(
            executingCell({ cellMetadata: { sql_integration_id: 'int-1' }, languageId: 'sql' }),
            NotebookCellExecutionState.Executing
        );

        verify(
            mockTelemetryService.trackEvent(
                deepEqual({ eventName: 'execute_cell', properties: { cellType: 'sql', integrationType: 'unknown' } })
            )
        ).once();
    });

    test('omits integrationType when the id is not in the project', () => {
        when(mockNotebookManager.getProjectForNotebook('project-1', 'notebook-1')).thenReturn({
            project: { integrations: [] }
        } as never);

        fireExecutionState(
            executingCell({ cellMetadata: { sql_integration_id: 'gone-integration' }, languageId: 'sql' }),
            NotebookCellExecutionState.Executing
        );

        verify(
            mockTelemetryService.trackEvent(deepEqual({ eventName: 'execute_cell', properties: { cellType: 'sql' } }))
        ).once();
    });
});
