import { expect } from 'chai';
import { anything, verify, when } from 'ts-mockito';
import { Disposable, NotebookCell, NotebookCellKind, NotebookDocument, TextDocument, Uri } from 'vscode';

import { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteNewCellLanguageService } from './deepnoteNewCellLanguageService';

suite('DeepnoteNewCellLanguageService', () => {
    let service: DeepnoteNewCellLanguageService;
    let disposables: Disposable[];
    let notebookChangeHandler: ((e: any) => void) | undefined;

    function createMockNotebook(notebookType: string): NotebookDocument {
        return {
            uri: Uri.file('/test/notebook.deepnote'),
            notebookType
        } as NotebookDocument;
    }

    function createMockCell(options: {
        kind?: NotebookCellKind;
        languageId?: string;
        content?: string;
        metadata?: Record<string, unknown>;
    }): NotebookCell {
        const { kind = NotebookCellKind.Code, languageId = 'python', content = '', metadata = {} } = options;

        return {
            index: 0,
            notebook: createMockNotebook('deepnote'),
            kind,
            document: {
                uri: Uri.file('/test/notebook.deepnote#cell0'),
                languageId,
                getText: () => content
            } as TextDocument,
            metadata,
            outputs: [],
            executionSummary: undefined
        } as unknown as NotebookCell;
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [];

        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).thenCall(
            (handler, thisArg) => {
                notebookChangeHandler = (e: any) => handler.call(thisArg, e);

                return { dispose: () => undefined };
            }
        );

        when(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).thenReturn(
            Promise.resolve({} as TextDocument)
        );

        service = new DeepnoteNewCellLanguageService(disposables as unknown as IDisposableRegistry);
    });

    teardown(() => {
        notebookChangeHandler = undefined;
        disposables.forEach((d) => d.dispose());
    });

    test('activate registers onDidChangeNotebookDocument listener', () => {
        service.activate();

        verify(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).once();
    });

    test('activate adds disposable to registry', () => {
        service.activate();

        expect(disposables.length).to.be.greaterThan(0);
    });

    test('ignores non-deepnote notebooks', async () => {
        service.activate();
        const jupyterNotebook = createMockNotebook('jupyter-notebook');
        const cell = createMockCell({ languageId: 'sql' });

        notebookChangeHandler!({
            notebook: jupyterNotebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('ignores markdown cells', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({ kind: NotebookCellKind.Markup, languageId: 'markdown' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('ignores cells with content', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({ languageId: 'sql', content: 'SELECT * FROM table' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('ignores cells that already have Python language', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({ languageId: 'python' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('ignores intentional SQL blocks (with __deepnotePocket.type)', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({
            languageId: 'sql',
            metadata: { __deepnotePocket: { type: 'sql' } }
        });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('ignores intentional chart blocks (with __deepnotePocket.type)', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({
            languageId: 'json',
            metadata: { __deepnotePocket: { type: 'chart-vega' } }
        });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('ignores intentional input blocks (with __deepnotePocket.type)', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({
            languageId: 'plaintext',
            metadata: { __deepnotePocket: { type: 'input-text' } }
        });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('changes SQL cell to Python when no __deepnotePocket metadata', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({ languageId: 'sql' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(cell.document, 'python')).once();
    });

    test('changes JSON cell to Python when no __deepnotePocket metadata', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({ languageId: 'json' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(cell.document, 'python')).once();
    });

    test('handles multiple added cells', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const sqlCell = createMockCell({ languageId: 'sql' });
        const pythonCell = createMockCell({ languageId: 'python' });
        const jsonCell = createMockCell({ languageId: 'json' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [sqlCell, pythonCell, jsonCell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(sqlCell.document, 'python')).once();
        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(pythonCell.document, anything())).never();
        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(jsonCell.document, 'python')).once();
    });

    test('handles multiple content changes', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell1 = createMockCell({ languageId: 'sql' });
        const cell2 = createMockCell({ languageId: 'javascript' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell1] }, { addedCells: [cell2] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(cell1.document, 'python')).once();
        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(cell2.document, 'python')).once();
    });

    test('ignores content changes with no added cells', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
    });

    test('changes cells with whitespace-only content to Python', async () => {
        service.activate();
        const notebook = createMockNotebook('deepnote');
        const cell = createMockCell({ languageId: 'sql', content: '   \n\t  ' });

        notebookChangeHandler!({
            notebook,
            contentChanges: [{ addedCells: [cell] }]
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(cell.document, 'python')).once();
    });
});
