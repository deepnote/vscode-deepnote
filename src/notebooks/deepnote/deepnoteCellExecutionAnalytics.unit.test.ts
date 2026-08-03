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
