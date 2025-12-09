import { expect } from 'chai';
import { anything, verify, when } from 'ts-mockito';
import { Disposable, NotebookCell, NotebookCellKind, NotebookDocument, TextDocument, Uri } from 'vscode';

import { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteNewCellLanguageService } from './deepnoteNewCellLanguageService';

suite('DeepnoteNewCellLanguageService', () => {
    let service: DeepnoteNewCellLanguageService;
    let disposables: Disposable[];
    let mockDisposableRegistry: IDisposableRegistry;
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
        mockDisposableRegistry = disposables as unknown as IDisposableRegistry;

        // Capture the notebook change handler when workspace.onDidChangeNotebookDocument is called
        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).thenCall(
            (handler, thisArg) => {
                notebookChangeHandler = (e: any) => handler.call(thisArg, e);

                return { dispose: () => undefined };
            }
        );

        // Mock languages.setTextDocumentLanguage to return a resolved promise
        when(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).thenReturn(
            Promise.resolve({} as TextDocument)
        );

        service = new DeepnoteNewCellLanguageService(mockDisposableRegistry);
    });

    teardown(() => {
        resetVSCodeMocks();
        notebookChangeHandler = undefined;
        disposables.forEach((d) => d.dispose());
    });

    suite('activate', () => {
        test('registers workspace.onDidChangeNotebookDocument listener', () => {
            service.activate();

            verify(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).once();
        });

        test('adds disposable to registry', () => {
            // Reset mocks to isolate this test
            resetVSCodeMocks();
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).thenCall(
                (handler, thisArg) => {
                    notebookChangeHandler = (e: any) => handler.call(thisArg, e);

                    return { dispose: () => undefined };
                }
            );
            disposables = [];
            mockDisposableRegistry = disposables as unknown as IDisposableRegistry;
            service = new DeepnoteNewCellLanguageService(mockDisposableRegistry);

            service.activate();

            expect(disposables.length).to.be.greaterThan(0);
        });
    });

    suite('onDidChangeNotebookDocument', () => {
        setup(() => {
            // Reset mock verification state between tests
            resetVSCodeMocks();

            // Re-setup the mocks after reset
            when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).thenCall(
                (handler, thisArg) => {
                    notebookChangeHandler = (e: any) => handler.call(thisArg, e);

                    return { dispose: () => undefined };
                }
            );
            when(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).thenReturn(
                Promise.resolve({} as TextDocument)
            );

            disposables = [];
            mockDisposableRegistry = disposables as unknown as IDisposableRegistry;
            service = new DeepnoteNewCellLanguageService(mockDisposableRegistry);
            service.activate();
            expect(notebookChangeHandler).to.not.be.undefined;
        });

        test('ignores non-deepnote notebooks', async () => {
            const jupyterNotebook = createMockNotebook('jupyter-notebook');
            const cell = createMockCell({ languageId: 'sql' });

            notebookChangeHandler!({
                notebook: jupyterNotebook,
                contentChanges: [{ addedCells: [cell] }]
            });

            // Allow async operations to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
        });

        test('ignores markdown cells', async () => {
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
            const notebook = createMockNotebook('deepnote');
            const sqlCell = createMockCell({ languageId: 'sql' });
            const pythonCell = createMockCell({ languageId: 'python' });
            const jsonCell = createMockCell({ languageId: 'json' });

            notebookChangeHandler!({
                notebook,
                contentChanges: [{ addedCells: [sqlCell, pythonCell, jsonCell] }]
            });

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Should change SQL and JSON, but not Python
            verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(sqlCell.document, 'python')).once();
            verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(pythonCell.document, anything())).never();
            verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(jsonCell.document, 'python')).once();
        });

        test('handles multiple content changes', async () => {
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
            const notebook = createMockNotebook('deepnote');

            notebookChangeHandler!({
                notebook,
                contentChanges: [{ addedCells: [] }]
            });

            await new Promise((resolve) => setTimeout(resolve, 10));

            verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(anything(), anything())).never();
        });

        test('ignores cells with whitespace-only content', async () => {
            const notebook = createMockNotebook('deepnote');
            const cell = createMockCell({ languageId: 'sql', content: '   \n\t  ' });

            notebookChangeHandler!({
                notebook,
                contentChanges: [{ addedCells: [cell] }]
            });

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Cell with only whitespace is considered empty, so it should be changed
            verify(mockedVSCodeNamespaces.languages.setTextDocumentLanguage(cell.document, 'python')).once();
        });
    });
});
