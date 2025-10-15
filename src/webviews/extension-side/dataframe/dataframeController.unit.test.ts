import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import {
    Disposable,
    NotebookCell,
    NotebookCellData,
    NotebookCellKind,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookDocument,
    NotebookEditor,
    NotebookRendererMessaging,
    Uri
} from 'vscode';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { IDisposable } from '../../../platform/common/types';
import { DataframeController } from './dataframeController';
import { createMockedNotebookDocument } from '../../../test/datascience/editor-integration/helpers';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

suite('DataframeController', () => {
    let controller: DataframeController;
    let disposables: IDisposable[] = [];
    let comms: NotebookRendererMessaging;
    let clipboard: any;

    setup(() => {
        resetVSCodeMocks();
        disposables.push(new Disposable(() => resetVSCodeMocks()));
        controller = new DataframeController();
        comms = mock<NotebookRendererMessaging>();

        // Get the mock clipboard instance from the env instance
        clipboard = instance(mockedVSCodeNamespaces.env).clipboard;

        // Mock workspace.fs for file operations
        const mockFs = {
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            writeFile: async (_uri: Uri, _content: Uint8Array) => {}
        };
        when(mockedVSCodeNamespaces.workspace.fs).thenReturn(mockFs as any);
    });

    teardown(() => {
        controller.dispose();
        disposables = dispose(disposables);
    });

    suite('CSV Conversion (dataframeToCsv)', () => {
        test('Should return empty string for null dataframe', () => {
            const result = (controller as any).dataframeToCsv(null);
            assert.strictEqual(result, '');
        });

        test('Should return empty string for undefined dataframe', () => {
            const result = (controller as any).dataframeToCsv(undefined);
            assert.strictEqual(result, '');
        });

        test('Should return empty string for dataframe without columns', () => {
            const dataframe = {
                column_count: 0,
                columns: undefined,
                preview_row_count: 0,
                row_count: 0,
                rows: [],
                type: 'dataframe'
            };
            const result = (controller as any).dataframeToCsv(dataframe);
            assert.strictEqual(result, '');
        });

        test('Should return empty string for dataframe without rows', () => {
            const dataframe = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'col1' },
                    { dtype: 'string', name: 'col2' }
                ],
                preview_row_count: 0,
                row_count: 0,
                rows: undefined,
                type: 'dataframe'
            };
            const result = (controller as any).dataframeToCsv(dataframe);
            assert.strictEqual(result, '');
        });

        test('Should filter out columns starting with _deepnote', () => {
            const dataframe = {
                column_count: 3,
                columns: [
                    { dtype: 'int64', name: 'col1' },
                    { dtype: 'string', name: '_deepnote_internal' },
                    { dtype: 'string', name: 'col2' }
                ],
                preview_row_count: 2,
                row_count: 2,
                rows: [
                    { col1: 1, _deepnote_internal: 'hidden', col2: 'a' },
                    { col1: 2, _deepnote_internal: 'hidden', col2: 'b' }
                ],
                type: 'dataframe'
            };
            const result = (controller as any).dataframeToCsv(dataframe);
            const lines = result.split('\n');

            assert.strictEqual(lines.length, 3);
            assert.strictEqual(lines[0], 'col1,col2');
            assert.strictEqual(lines[1], '1,a');
            assert.strictEqual(lines[2], '2,b');
        });

        test('Should properly format CSV with headers and data rows', () => {
            const dataframe = {
                column_count: 3,
                columns: [
                    { dtype: 'int64', name: 'id' },
                    { dtype: 'string', name: 'name' },
                    { dtype: 'float64', name: 'score' }
                ],
                preview_row_count: 2,
                row_count: 2,
                rows: [
                    { id: 1, name: 'Alice', score: 95.5 },
                    { id: 2, name: 'Bob', score: 87.3 }
                ],
                type: 'dataframe'
            };
            const result = (controller as any).dataframeToCsv(dataframe);
            const lines = result.split('\n');

            assert.strictEqual(lines.length, 3);
            assert.strictEqual(lines[0], 'id,name,score');
            assert.strictEqual(lines[1], '1,Alice,95.5');
            assert.strictEqual(lines[2], '2,Bob,87.3');
        });

        test('Should handle empty column names', () => {
            const dataframe = {
                column_count: 3,
                columns: [
                    { dtype: 'int64', name: 'col1' },
                    { dtype: 'string', name: '' },
                    { dtype: 'string', name: 'col2' }
                ],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ col1: 1, '': 'empty', col2: 'a' }],
                type: 'dataframe'
            };
            const result = (controller as any).dataframeToCsv(dataframe);
            const lines = result.split('\n');

            assert.strictEqual(lines[0], 'col1,col2');
        });

        test('Should handle case-insensitive _deepnote filtering', () => {
            const dataframe = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'col1' },
                    { dtype: 'string', name: '_DEEPNOTE_test' }
                ],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ col1: 1, _DEEPNOTE_test: 'hidden' }],
                type: 'dataframe'
            };
            const result = (controller as any).dataframeToCsv(dataframe);
            const lines = result.split('\n');

            assert.strictEqual(lines[0], 'col1');
            assert.strictEqual(lines[1], '1');
        });
    });

    suite('Dataframe Extraction (getDataframeFromDataframeOutput)', () => {
        test('Should show error for empty outputs array', async () => {
            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve();
            });

            try {
                await (controller as any).getDataframeFromDataframeOutput([]);
                assert.fail('Should have thrown an error');
            } catch (error) {
                assert.isTrue(errorShown);
                assert.include((error as Error).message, 'No outputs found');
            }
        });

        test('Should show error when dataframe MIME type not found', async () => {
            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve();
            });

            const outputs = [new NotebookCellOutput([NotebookCellOutputItem.text('some text', 'text/plain')])];

            try {
                await (controller as any).getDataframeFromDataframeOutput(outputs);
                assert.fail('Should have thrown an error');
            } catch (error) {
                assert.isTrue(errorShown);
                assert.include((error as Error).message, 'No dataframe output found');
            }
        });

        test('Should successfully parse valid dataframe JSON', async () => {
            const dataframeData = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'col1' },
                    { dtype: 'string', name: 'col2' }
                ],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ col1: 1, col2: 'test' }],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const outputs = [
                new NotebookCellOutput([
                    new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                ])
            ];

            const result = await (controller as any).getDataframeFromDataframeOutput(outputs);

            assert.isDefined(result);
            assert.deepStrictEqual(result, dataframeData);
        });
    });

    suite('Copy Table (handleCopyTable)', () => {
        test('Should show error when cellId is missing', async () => {
            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                throw new Error('No cell identifier');
            });

            const editor = createMockEditor([]);
            const message = { command: 'copyTable' as const };

            try {
                await (controller as any).handleCopyTable(editor, message);
            } catch (e) {
                // Expected
            }

            assert.isTrue(errorShown);
        });

        test('Should show error when cell not found', async () => {
            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                throw new Error('Cell not found');
            });

            const cell = createCellWithOutputs('print(1)', [], { id: 'cell1' });
            const { editor } = createNotebookWithCell(cell);

            const message = { command: 'copyTable' as const, cellId: 'nonexistent' };

            try {
                await (controller as any).handleCopyTable(editor, message);
            } catch (e) {
                // Expected
            }

            assert.isTrue(errorShown);
        });

        test('Should successfully copy dataframe to clipboard', async () => {
            const dataframeData = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'id' },
                    { dtype: 'string', name: 'name' }
                ],
                preview_row_count: 2,
                row_count: 2,
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' }
                ],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            let messageShown = false;

            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall(() => {
                messageShown = true;
                return Promise.resolve();
            });

            const message = { command: 'copyTable' as const, cellId: 'cell1' };

            await (controller as any).handleCopyTable(editor, message);

            const clipboardContent = await clipboard.readText();
            assert.strictEqual(clipboardContent, 'id,name\n1,Alice\n2,Bob');
            assert.isTrue(messageShown);
        });

        test('Should show error when dataframe is empty', async () => {
            const dataframeData = {
                column_count: 0,
                columns: [],
                preview_row_count: 0,
                row_count: 0,
                rows: [],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                throw new Error('Empty dataframe');
            });

            const message = { command: 'copyTable' as const, cellId: 'cell1' };

            try {
                await (controller as any).handleCopyTable(editor, message);
            } catch (e) {
                // Expected
            }

            assert.isTrue(errorShown);
        });
    });

    suite('Export Table (handleExportTable)', () => {
        test('Should show error when cellId is missing', async () => {
            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                throw new Error('No cell identifier');
            });

            const editor = createMockEditor([]);
            const message = { command: 'exportTable' as const };

            try {
                await (controller as any).handleExportTable(editor, message);
            } catch (e) {
                // Expected
            }

            assert.isTrue(errorShown);
        });

        test('Should show error when cell not found', async () => {
            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                throw new Error('Cell not found');
            });

            const cell = createCellWithOutputs('print(1)', [], { id: 'cell1' });
            const { editor } = createNotebookWithCell(cell);

            const message = { command: 'exportTable' as const, cellId: 'nonexistent' };

            try {
                await (controller as any).handleExportTable(editor, message);
            } catch (e) {
                // Expected
            }

            assert.isTrue(errorShown);
        });

        test('Should handle user canceling save dialog', async () => {
            const dataframeData = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'id' },
                    { dtype: 'string', name: 'name' }
                ],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ id: 1, name: 'Alice' }],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            when(mockedVSCodeNamespaces.window.showSaveDialog(anything())).thenResolve(undefined);

            const message = { command: 'exportTable' as const, cellId: 'cell1' };

            await (controller as any).handleExportTable(editor, message);

            // Should not throw, just return
        });

        test('Should successfully write file when user confirms', async () => {
            const dataframeData = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'id' },
                    { dtype: 'string', name: 'name' }
                ],
                preview_row_count: 2,
                row_count: 2,
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' }
                ],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            const saveUri = Uri.file('/tmp/test.csv');
            let fileWritten = false;
            let writtenContent = '';
            let messageShown = false;

            // Mock fs.writeFile to track calls
            const mockFs = {
                writeFile: async (_uri: Uri, content: Uint8Array) => {
                    fileWritten = true;
                    writtenContent = new TextDecoder().decode(content);
                }
            };
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(mockFs as any);

            when(mockedVSCodeNamespaces.window.showSaveDialog(anything())).thenReturn(Promise.resolve(saveUri));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenCall(() => {
                messageShown = true;
                return Promise.resolve();
            });

            const message = { command: 'exportTable' as const, cellId: 'cell1' };

            await (controller as any).handleExportTable(editor, message);

            assert.isTrue(fileWritten);
            assert.strictEqual(writtenContent, 'id,name\n1,Alice\n2,Bob');
            assert.isTrue(messageShown);
        });

        test('Should show error message when file write fails', async () => {
            const dataframeData = {
                column_count: 2,
                columns: [
                    { dtype: 'int64', name: 'id' },
                    { dtype: 'string', name: 'name' }
                ],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ id: 1, name: 'Alice' }],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            const saveUri = Uri.file('/tmp/test.csv');
            let errorShown = false;

            // Mock fs.writeFile to throw an error
            const mockFs = {
                writeFile: async (_uri: Uri, _content: Uint8Array) => {
                    throw new Error('Permission denied');
                }
            };
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(mockFs as any);

            when(mockedVSCodeNamespaces.window.showSaveDialog(anything())).thenReturn(Promise.resolve(saveUri));
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                return Promise.resolve();
            });

            const message = { command: 'exportTable' as const, cellId: 'cell1' };

            await (controller as any).handleExportTable(editor, message);

            assert.isTrue(errorShown);
        });

        test('Should show error when dataframe is empty', async () => {
            const dataframeData = {
                column_count: 0,
                columns: [],
                preview_row_count: 0,
                row_count: 0,
                rows: [],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            let errorShown = false;
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenCall(() => {
                errorShown = true;
                throw new Error('Empty dataframe');
            });

            const message = { command: 'exportTable' as const, cellId: 'cell1' };

            try {
                await (controller as any).handleExportTable(editor, message);
            } catch (e) {
                // Expected
            }

            assert.isTrue(errorShown);
        });
    });

    suite('Message Routing (onDidReceiveMessage)', () => {
        test('Should handle copyTable command', async () => {
            const dataframeData = {
                column_count: 1,
                columns: [{ dtype: 'int64', name: 'col1' }],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ col1: 1 }],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve();

            const message = { command: 'copyTable' as const, cellId: 'cell1' };

            await (controller as any).onDidReceiveMessage(instance(comms), { editor, message });

            const clipboardContent = await clipboard.readText();
            assert.strictEqual(clipboardContent, 'col1\n1');
        });

        test('Should handle exportTable command', async () => {
            const dataframeData = {
                column_count: 1,
                columns: [{ dtype: 'int64', name: 'col1' }],
                preview_row_count: 1,
                row_count: 1,
                rows: [{ col1: 1 }],
                type: 'dataframe'
            };

            const jsonString = JSON.stringify(dataframeData);
            const encoder = new TextEncoder();
            const buffer = encoder.encode(jsonString);

            const cell = createCellWithOutputs(
                'df',
                [
                    new NotebookCellOutput([
                        new NotebookCellOutputItem(buffer, 'application/vnd.deepnote.dataframe.v3+json')
                    ])
                ],
                { id: 'cell1' }
            );

            const { editor } = createNotebookWithCell(cell);

            const saveUri = Uri.file('/tmp/test.csv');
            let exportHandled = false;

            // Mock fs.writeFile to track calls
            const mockFs = {
                writeFile: async (_uri: Uri, _content: Uint8Array) => {
                    exportHandled = true;
                }
            };
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(mockFs as any);

            when(mockedVSCodeNamespaces.window.showSaveDialog(anything())).thenReturn(Promise.resolve(saveUri));
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve();

            const message = { command: 'exportTable' as const, cellId: 'cell1' };

            await (controller as any).onDidReceiveMessage(instance(comms), { editor, message });

            assert.isTrue(exportHandled);
        });

        test('Should ignore null or invalid messages', async () => {
            const editor = createMockEditor([]);

            await (controller as any).onDidReceiveMessage(instance(comms), { editor, message: null });
            await (controller as any).onDidReceiveMessage(instance(comms), { editor, message: 'invalid' });

            // Should not throw
        });
    });

    function createMockEditor(cells: NotebookCellData[]): NotebookEditor {
        const notebook = createMockedNotebookDocument(cells);
        return {
            notebook
        } as NotebookEditor;
    }

    function createCellWithOutputs(
        value: string,
        outputs: NotebookCellOutput[],
        metadata: Record<string, any> = {}
    ): NotebookCell {
        const cell = mock<NotebookCell>();
        when(cell.outputs).thenReturn(outputs);
        when(cell.metadata).thenReturn(metadata);
        when(cell.kind).thenReturn(NotebookCellKind.Code);
        when(cell.index).thenReturn(0);
        const document = mock<any>();
        when(document.getText()).thenReturn(value);
        when(cell.document).thenReturn(instance(document));
        return instance(cell);
    }

    function createNotebookWithCell(cell: NotebookCell): { notebook: NotebookDocument; editor: NotebookEditor } {
        const notebook = mock<NotebookDocument>();
        when(notebook.getCells()).thenReturn([cell]);
        when(notebook.cellAt(0)).thenReturn(cell);
        when(notebook.cellCount).thenReturn(1);

        const editor = {
            notebook: instance(notebook)
        } as NotebookEditor;

        return { notebook: instance(notebook), editor };
    }
});
