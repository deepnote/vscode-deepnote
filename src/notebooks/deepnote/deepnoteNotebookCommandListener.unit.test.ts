import { assert } from 'chai';
import * as sinon from 'sinon';
import {
    NotebookCell,
    NotebookDocument,
    NotebookEditor,
    NotebookRange,
    NotebookCellKind,
    NotebookCellData,
    WorkspaceEdit,
    commands,
    window,
    Uri
} from 'vscode';

import {
    DeepnoteNotebookCommandListener,
    getNextDeepnoteVariableName,
    InputBlockType
} from './deepnoteNotebookCommandListener';
import { IDisposable } from '../../platform/common/types';
import * as notebookUpdater from '../../kernels/execution/notebookUpdater';
import { createMockedNotebookDocument } from '../../test/datascience/editor-integration/helpers';

suite('DeepnoteNotebookCommandListener', () => {
    let commandListener: DeepnoteNotebookCommandListener;
    let disposables: IDisposable[];

    setup(() => {
        disposables = [];
        commandListener = new DeepnoteNotebookCommandListener(disposables);
    });

    teardown(() => {
        disposables.forEach((d) => d?.dispose());
    });

    suite('activate', () => {
        test('should register commands when activated', () => {
            assert.isEmpty(disposables, 'Disposables should be empty');

            commandListener.activate();

            // Verify that at least one command was registered (AddSqlBlock)
            assert.isAtLeast(disposables.length, 1, 'Should register at least one command');
        });

        test('should handle activation without errors', () => {
            assert.doesNotThrow(() => {
                commandListener.activate();
            }, 'activate() should not throw errors');
        });

        test('should register disposable command handlers', () => {
            commandListener.activate();

            // Verify disposables were registered
            assert.isAtLeast(disposables.length, 1, 'Should register command disposables');

            // Verify all registered items are disposable (filter out null/undefined first)
            const validDisposables = disposables.filter((d) => d != null);
            validDisposables.forEach((d) => {
                assert.isDefined(d.dispose, 'Each registered item should have a dispose method');
            });
        });
    });

    suite('command registration', () => {
        test('should not register duplicate commands on multiple activations', () => {
            commandListener.activate();
            const firstActivationCount = disposables.length;

            // Create new instance and activate again
            const disposables2: IDisposable[] = [];
            const commandListener2 = new DeepnoteNotebookCommandListener(disposables2);
            commandListener2.activate();

            // Both should register the same number of commands
            assert.equal(
                disposables2.length,
                firstActivationCount,
                'Both activations should register the same number of commands'
            );

            disposables2.forEach((d) => d?.dispose());
        });
    });

    suite('getNextDeepnoteVariableName', () => {
        /**
         * Helper function to create a mock NotebookCell
         */
        function createMockCell(content: string, metadata?: Record<string, any>): NotebookCell {
            return {
                document: {
                    getText: () => content
                },
                metadata: metadata || {}
            } as NotebookCell;
        }

        const TEST_INPUTS: Array<{
            description: string;
            cells: NotebookCell[];
            prefix: 'df' | 'query' | 'input';
            expected: string;
        }> = [
            // Tests with 'input' prefix
            {
                description: 'should return input_1 for empty cells array',
                cells: [],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should return input_1 when no variable names exist',
                cells: [createMockCell('{ "some_other_field": "value" }'), createMockCell('{ "data": "test" }')],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should return input_2 when input_1 exists in content JSON',
                cells: [createMockCell('{ "deepnote_variable_name": "input_1" }')],
                prefix: 'input',
                expected: 'input_2'
            },
            {
                description: 'should return input_3 when input_1 and input_2 exist',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_1" }'),
                    createMockCell('{ "deepnote_variable_name": "input_2" }')
                ],
                prefix: 'input',
                expected: 'input_3'
            },
            {
                description: 'should return input_6 when max suffix is input_5',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_1" }'),
                    createMockCell('{ "deepnote_variable_name": "input_5" }'),
                    createMockCell('{ "deepnote_variable_name": "input_3" }')
                ],
                prefix: 'input',
                expected: 'input_6'
            },
            {
                description: 'should return input_1 when variable names have no numeric suffix',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "my_variable" }'),
                    createMockCell('{ "deepnote_variable_name": "another_var" }')
                ],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should return input_11 when input_10 exists',
                cells: [createMockCell('{ "deepnote_variable_name": "input_10" }')],
                prefix: 'input',
                expected: 'input_11'
            },
            {
                description: 'should extract variable name from metadata',
                cells: [
                    createMockCell('{}', {
                        __deepnotePocket: { deepnote_variable_name: 'input_7' }
                    })
                ],
                prefix: 'input',
                expected: 'input_8'
            },
            {
                description: 'should handle both content and metadata variable names',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_2" }'),
                    createMockCell('{}', {
                        __deepnotePocket: { deepnote_variable_name: 'input_5' }
                    }),
                    createMockCell('{ "deepnote_variable_name": "input_3" }')
                ],
                prefix: 'input',
                expected: 'input_6'
            },
            {
                description: 'should handle mixed variable names with and without numbers',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "my_custom_input" }'),
                    createMockCell('{ "deepnote_variable_name": "input_4" }'),
                    createMockCell('{ "deepnote_variable_name": "another_variable" }')
                ],
                prefix: 'input',
                expected: 'input_5'
            },
            {
                description: 'should handle invalid JSON gracefully',
                cells: [createMockCell('not valid json'), createMockCell('{ "deepnote_variable_name": "input_3" }')],
                prefix: 'input',
                expected: 'input_4'
            },
            {
                description: 'should handle cells with both content and metadata, preferring the highest',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_2" }', {
                        __deepnotePocket: { deepnote_variable_name: 'input_8' }
                    })
                ],
                prefix: 'input',
                expected: 'input_9'
            },
            {
                description: 'should handle non-numeric suffixes in variable names',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_abc" }'),
                    createMockCell('{ "deepnote_variable_name": "input_5" }')
                ],
                prefix: 'input',
                expected: 'input_6'
            },
            {
                description: 'should return input_1 when only zero-suffixed names exist',
                cells: [createMockCell('{ "deepnote_variable_name": "input_0" }')],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should handle large numbers correctly',
                cells: [createMockCell('{ "deepnote_variable_name": "input_999" }')],
                prefix: 'input',
                expected: 'input_1000'
            },

            // Tests with 'df' prefix
            {
                description: 'should return df_1 for empty cells array with df prefix',
                cells: [],
                prefix: 'df',
                expected: 'df_1'
            },
            {
                description: 'should return df_2 when df_1 exists',
                cells: [createMockCell('{ "deepnote_variable_name": "df_1" }')],
                prefix: 'df',
                expected: 'df_2'
            },
            {
                description: 'should return df_5 when df_4 exists and ignore input_ variables',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "df_4" }'),
                    createMockCell('{ "deepnote_variable_name": "input_10" }'),
                    createMockCell('{ "deepnote_variable_name": "query_7" }')
                ],
                prefix: 'df',
                expected: 'df_5'
            },
            {
                description: 'should return df_1 when only input_ variables exist',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_5" }'),
                    createMockCell('{ "deepnote_variable_name": "input_10" }')
                ],
                prefix: 'df',
                expected: 'df_1'
            },

            // Tests with 'query' prefix
            {
                description: 'should return query_1 for empty cells array with query prefix',
                cells: [],
                prefix: 'query',
                expected: 'query_1'
            },
            {
                description: 'should return query_3 when query_1 and query_2 exist',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "query_1" }'),
                    createMockCell('{ "deepnote_variable_name": "query_2" }')
                ],
                prefix: 'query',
                expected: 'query_3'
            },
            {
                description: 'should return query_8 when max suffix is query_7 and ignore other prefixes',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "query_7" }'),
                    createMockCell('{ "deepnote_variable_name": "df_100" }'),
                    createMockCell('{ "deepnote_variable_name": "input_50" }')
                ],
                prefix: 'query',
                expected: 'query_8'
            },

            // Mixed prefix tests
            {
                description: 'should only count matching prefix when multiple prefixes exist',
                cells: [
                    createMockCell('{ "deepnote_variable_name": "input_5" }'),
                    createMockCell('{ "deepnote_variable_name": "df_3" }'),
                    createMockCell('{ "deepnote_variable_name": "query_2" }'),
                    createMockCell('{ "deepnote_variable_name": "input_8" }')
                ],
                prefix: 'input',
                expected: 'input_9'
            },
            {
                description: 'should handle metadata with different prefix',
                cells: [
                    createMockCell('{}', {
                        __deepnotePocket: { deepnote_variable_name: 'df_15' }
                    }),
                    createMockCell('{ "deepnote_variable_name": "df_20" }')
                ],
                prefix: 'df',
                expected: 'df_21'
            }
        ];

        TEST_INPUTS.forEach(({ description, cells, prefix, expected }) => {
            test(description, () => {
                const result = getNextDeepnoteVariableName(cells, prefix);
                assert.equal(result, expected);
            });
        });
    });

    suite('addBlock', () => {
        let sandbox: sinon.SinonSandbox;

        setup(() => {
            sandbox = sinon.createSandbox();
        });

        teardown(() => {
            sandbox.restore();
        });

        /**
         * Helper to create mock NotebookCell with metadata
         */
        function createMockCell(content: string, metadata?: Record<string, any>): NotebookCellData {
            const cell = new NotebookCellData(NotebookCellKind.Code, content, 'json');
            if (metadata != null) {
                cell.metadata = metadata;
            }
            return cell;
        }

        /**
         * Helper to create mock NotebookEditor and NotebookDocument
         */
        function createMockEditor(
            cellDataArray: NotebookCellData[],
            selection?: NotebookRange
        ): {
            editor: NotebookEditor;
            document: NotebookDocument;
        } {
            const uri = Uri.file('/test/notebook.ipynb');
            const document = createMockedNotebookDocument(cellDataArray, {}, uri);

            const editorSelection =
                selection != null ? selection : new NotebookRange(0, cellDataArray.length > 0 ? 1 : 0);

            const editor: NotebookEditor = {
                notebook: document,
                selection: editorSelection,
                selections: [editorSelection],
                visibleRanges: [],
                revealRange: sandbox.stub()
            };

            return { editor, document };
        }

        function mockNotebookUpdateAndExecute(editor: NotebookEditor) {
            Object.defineProperty(window, 'activeNotebookEditor', {
                value: editor,
                configurable: true,
                writable: true
            });

            let capturedNotebookEdits: any[] | null = null;

            // Mock chainWithPendingUpdates to capture the edit and resolve immediately
            const chainStub = sandbox
                .stub(notebookUpdater, 'chainWithPendingUpdates')
                .callsFake((_doc: NotebookDocument, callback: (edit: WorkspaceEdit) => void) => {
                    const edit = new WorkspaceEdit();
                    // Stub the set method to capture the notebook edits
                    sandbox.stub(edit, 'set').callsFake((_uri, edits) => {
                        capturedNotebookEdits = edits as any[];
                    });
                    callback(edit);
                    return Promise.resolve(true);
                });

            // Mock commands.executeCommand
            const executeCommandStub = sandbox.stub().resolves();
            Object.defineProperty(commands, 'executeCommand', {
                value: executeCommandStub,
                configurable: true,
                writable: true
            });

            return {
                chainStub,
                executeCommandStub,
                getCapturedNotebookEdits: () => capturedNotebookEdits
            };
        }

        const TEST_INPUTS: Array<{
            description: string;
            blockType: InputBlockType;
            existingCells: NotebookCellData[];
            selection?: NotebookRange;
            expectedInsertIndex: number;
            expectedVariableName: string;
            expectedMetadataKeys: string[];
        }> = [
            {
                description: 'should add input-text block at the end when no selection exists',
                blockType: 'input-text',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should add input-text block after selection when selection exists',
                blockType: 'input-text',
                existingCells: [createMockCell('{}')],
                selection: new NotebookRange(0, 1),
                expectedInsertIndex: 1,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should add input-textarea block with correct metadata',
                blockType: 'input-textarea',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should add input-select block with correct metadata',
                blockType: 'input-select',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: [
                    'deepnote_variable_name',
                    'deepnote_input_label',
                    'deepnote_variable_value',
                    'deepnote_variable_options'
                ]
            },
            {
                description: 'should add input-slider block with correct metadata',
                blockType: 'input-slider',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: [
                    'deepnote_variable_name',
                    'deepnote_input_label',
                    'deepnote_variable_value',
                    'deepnote_slider_min_value',
                    'deepnote_slider_max_value',
                    'deepnote_slider_step'
                ]
            },
            {
                description: 'should add input-checkbox block with correct metadata',
                blockType: 'input-checkbox',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should add input-date block with correct metadata',
                blockType: 'input-date',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: [
                    'deepnote_variable_name',
                    'deepnote_input_label',
                    'deepnote_variable_value',
                    'deepnote_input_date_version'
                ]
            },
            {
                description: 'should add input-date-range block with correct metadata',
                blockType: 'input-date-range',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should add input-file block with correct metadata',
                blockType: 'input-file',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: [
                    'deepnote_variable_name',
                    'deepnote_input_label',
                    'deepnote_variable_value',
                    'deepnote_allowed_file_extensions'
                ]
            },
            {
                description: 'should add button block with correct metadata',
                blockType: 'button',
                existingCells: [],
                selection: undefined,
                expectedInsertIndex: 0,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: [
                    'deepnote_variable_name',
                    'deepnote_button_title',
                    'deepnote_button_behavior',
                    'deepnote_button_color_scheme'
                ]
            },
            {
                description: 'should generate correct variable name when existing inputs exist',
                blockType: 'input-text',
                existingCells: [
                    createMockCell('{ "deepnote_variable_name": "input_1" }'),
                    createMockCell('{ "deepnote_variable_name": "input_2" }')
                ],
                selection: new NotebookRange(1, 2),
                expectedInsertIndex: 2,
                expectedVariableName: 'input_3',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should insert at selection.end when selection is in the middle',
                blockType: 'input-text',
                existingCells: [createMockCell('{}'), createMockCell('{}'), createMockCell('{}')],
                selection: new NotebookRange(1, 2),
                expectedInsertIndex: 2,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should handle large variable numbers correctly',
                blockType: 'input-text',
                existingCells: [createMockCell('{ "deepnote_variable_name": "input_99" }')],
                selection: undefined,
                expectedInsertIndex: 1,
                expectedVariableName: 'input_100',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            }
        ];

        TEST_INPUTS.forEach(
            ({
                description,
                blockType,
                existingCells,
                selection,
                expectedInsertIndex,
                expectedVariableName,
                expectedMetadataKeys
            }) => {
                test(description, async () => {
                    // Setup mocks
                    const { editor, document } = createMockEditor(existingCells, selection);

                    const { chainStub, executeCommandStub, getCapturedNotebookEdits } =
                        mockNotebookUpdateAndExecute(editor);

                    // Call the method and await it
                    await commandListener.addInputBlock(blockType);

                    const capturedNotebookEdits = getCapturedNotebookEdits();

                    // Verify chainWithPendingUpdates was called
                    assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');
                    assert.equal(chainStub.firstCall.args[0], document, 'Should be called with correct document');

                    // Verify the edits were captured
                    assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                    assert.isDefined(capturedNotebookEdits, 'Notebook edits should be defined');

                    // Verify cell was inserted at correct index
                    // TypeScript type narrowing issue - we've already asserted it's not null
                    const editsArray = capturedNotebookEdits!;
                    assert.equal(editsArray.length, 1, 'Should have one notebook edit');

                    const notebookEdit = editsArray[0] as any;
                    assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');

                    const newCell = notebookEdit.newCells[0];
                    assert.equal(newCell.kind, NotebookCellKind.Code, 'Should be a code cell');
                    assert.equal(newCell.languageId, 'json', 'Should have json language');

                    // Verify cell content is valid JSON with correct structure
                    const content = JSON.parse(newCell.value);
                    assert.equal(
                        content.deepnote_variable_name,
                        expectedVariableName,
                        'Variable name should match expected'
                    );

                    // Verify all expected metadata keys are present in content
                    expectedMetadataKeys.forEach((key) => {
                        assert.property(content, key, `Content should have ${key} property`);
                    });

                    // Verify metadata structure
                    assert.property(newCell.metadata, '__deepnotePocket', 'Should have __deepnotePocket metadata');
                    assert.equal(newCell.metadata.__deepnotePocket.type, blockType, 'Should have correct block type');
                    assert.equal(
                        newCell.metadata.__deepnotePocket.deepnote_variable_name,
                        expectedVariableName,
                        'Metadata should have correct variable name'
                    );

                    // Verify metadata keys match content keys
                    expectedMetadataKeys.forEach((key) => {
                        assert.property(newCell.metadata.__deepnotePocket, key, `Metadata should have ${key} property`);
                    });

                    // Verify reveal and selection were set
                    assert.isTrue(
                        (editor.revealRange as sinon.SinonStub).calledOnce,
                        'Should reveal the new cell range'
                    );
                    const revealCall = (editor.revealRange as sinon.SinonStub).firstCall;
                    assert.equal(revealCall.args[0].start, expectedInsertIndex, 'Should reveal correct range start');
                    assert.equal(revealCall.args[0].end, expectedInsertIndex + 1, 'Should reveal correct range end');

                    // Verify notebook.cell.edit command was executed
                    assert.isTrue(
                        executeCommandStub.calledWith('notebook.cell.edit'),
                        'Should execute notebook.cell.edit command'
                    );
                });
            }
        );

        test('should do nothing when no active editor exists', async () => {
            // Setup: no active editor
            Object.defineProperty(window, 'activeNotebookEditor', {
                value: undefined,
                configurable: true,
                writable: true
            });

            const chainStub = sandbox.stub(notebookUpdater, 'chainWithPendingUpdates');

            // Call the method
            await assert.isRejected(
                commandListener.addInputBlock('input-text'),
                Error,
                'No active notebook editor found'
            );

            // Verify chainWithPendingUpdates was NOT called
            assert.isFalse(chainStub.called, 'chainWithPendingUpdates should not be called when no editor exists');
        });

        test('should handle errors in chainWithPendingUpdates gracefully', async () => {
            // Setup mocks
            const { editor } = createMockEditor([]);
            Object.defineProperty(window, 'activeNotebookEditor', {
                value: editor,
                configurable: true,
                writable: true
            });

            // Mock chainWithPendingUpdates to reject
            const chainStub = sandbox.stub(notebookUpdater, 'chainWithPendingUpdates').rejects(new Error('Test error'));

            // Call the method - should not throw
            await assert.isRejected(commandListener.addInputBlock('input-text'), Error, 'Test error');

            // Verify chainWithPendingUpdates was called
            assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called');
        });

        suite('addSqlBlock', () => {
            test('should add SQL block at the end when no selection exists', async () => {
                // Setup mocks
                const { editor, document } = createMockEditor([], undefined);
                const { chainStub, executeCommandStub, getCapturedNotebookEdits } =
                    mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addSqlBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();

                // Verify chainWithPendingUpdates was called
                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');
                assert.equal(chainStub.firstCall.args[0], document, 'Should be called with correct document');

                // Verify the edits were captured
                assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                assert.isDefined(capturedNotebookEdits, 'Notebook edits should be defined');

                const editsArray = capturedNotebookEdits!;
                assert.equal(editsArray.length, 1, 'Should have one notebook edit');

                const notebookEdit = editsArray[0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');

                const newCell = notebookEdit.newCells[0];
                assert.equal(newCell.kind, NotebookCellKind.Code, 'Should be a code cell');
                assert.equal(newCell.languageId, 'sql', 'Should have sql language');
                assert.equal(newCell.value, '', 'Should have empty content');

                // Verify metadata structure
                assert.property(newCell.metadata, '__deepnotePocket', 'Should have __deepnotePocket metadata');
                assert.equal(newCell.metadata.__deepnotePocket.type, 'sql', 'Should have sql type');
                assert.equal(newCell.metadata.deepnote_variable_name, 'df_1', 'Should have correct variable name');
                assert.equal(
                    newCell.metadata.deepnote_return_variable_type,
                    'dataframe',
                    'Should have dataframe return type'
                );
                assert.equal(
                    newCell.metadata.sql_integration_id,
                    'deepnote-dataframe-sql',
                    'Should have correct sql integration id'
                );

                // Verify reveal and selection were set
                assert.isTrue((editor.revealRange as sinon.SinonStub).calledOnce, 'Should reveal the new cell range');
                const revealCall = (editor.revealRange as sinon.SinonStub).firstCall;
                assert.equal(revealCall.args[0].start, 0, 'Should reveal correct range start');
                assert.equal(revealCall.args[0].end, 1, 'Should reveal correct range end');
                assert.equal(revealCall.args[1], 0, 'Should use NotebookEditorRevealType.Default (value 0)');

                // Verify notebook.cell.edit command was executed
                assert.isTrue(
                    executeCommandStub.calledWith('notebook.cell.edit'),
                    'Should execute notebook.cell.edit command'
                );
            });

            test('should add SQL block after selection when selection exists', async () => {
                // Setup mocks
                const existingCells = [createMockCell('{}'), createMockCell('{}')];
                const selection = new NotebookRange(1, 2);
                const { editor } = createMockEditor(existingCells, selection);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addSqlBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();

                // Verify chainWithPendingUpdates was called
                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');

                // Verify a cell was inserted
                assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                const notebookEdit = capturedNotebookEdits![0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');
                assert.equal(notebookEdit.newCells[0].languageId, 'sql', 'Should be SQL cell');
            });

            test('should generate correct variable name when existing df variables exist', async () => {
                // Setup mocks with existing df variables
                const existingCells = [
                    createMockCell('{ "deepnote_variable_name": "df_1" }'),
                    createMockCell('{ "deepnote_variable_name": "df_2" }')
                ];
                const { editor } = createMockEditor(existingCells, undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addSqlBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();
                const notebookEdit = capturedNotebookEdits![0] as any;
                const newCell = notebookEdit.newCells[0];

                // Verify variable name is df_3
                assert.equal(newCell.metadata.deepnote_variable_name, 'df_3', 'Should generate next variable name');
            });

            test('should ignore input variables when generating df variable name', async () => {
                // Setup mocks with input variables (should not affect df numbering)
                const existingCells = [
                    createMockCell('{ "deepnote_variable_name": "input_10" }'),
                    createMockCell('{ "deepnote_variable_name": "df_2" }')
                ];
                const { editor } = createMockEditor(existingCells, undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addSqlBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();
                const notebookEdit = capturedNotebookEdits![0] as any;
                const newCell = notebookEdit.newCells[0];

                // Verify variable name is df_3 (not affected by input_10)
                assert.equal(newCell.metadata.deepnote_variable_name, 'df_3', 'Should only consider df variables');
            });

            test('should throw error when no active editor exists', async () => {
                // Setup: no active editor
                Object.defineProperty(window, 'activeNotebookEditor', {
                    value: undefined,
                    configurable: true,
                    writable: true
                });

                // Call the method and expect rejection
                await assert.isRejected(commandListener.addSqlBlock(), Error, 'No active notebook editor found');
            });

            test('should throw error when chainWithPendingUpdates fails', async () => {
                // Setup mocks
                const { editor } = createMockEditor([], undefined);
                Object.defineProperty(window, 'activeNotebookEditor', {
                    value: editor,
                    configurable: true,
                    writable: true
                });

                // Mock chainWithPendingUpdates to return false
                sandbox.stub(notebookUpdater, 'chainWithPendingUpdates').resolves(false);

                // Call the method and expect rejection
                await assert.isRejected(commandListener.addSqlBlock(), Error, 'Failed to insert SQL block');
            });
        });

        suite('addBigNumberChartBlock', () => {
            test('should add big number block at the end when no selection exists', async () => {
                // Setup mocks
                const { editor, document } = createMockEditor([], undefined);
                const { chainStub, executeCommandStub, getCapturedNotebookEdits } =
                    mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addBigNumberChartBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();

                // Verify chainWithPendingUpdates was called
                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');
                assert.equal(chainStub.firstCall.args[0], document, 'Should be called with correct document');

                // Verify the edits were captured
                assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                assert.isDefined(capturedNotebookEdits, 'Notebook edits should be defined');

                const editsArray = capturedNotebookEdits!;
                assert.equal(editsArray.length, 1, 'Should have one notebook edit');

                const notebookEdit = editsArray[0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');

                const newCell = notebookEdit.newCells[0];
                assert.equal(newCell.kind, NotebookCellKind.Code, 'Should be a code cell');
                assert.equal(newCell.languageId, 'json', 'Should have json language');

                // Verify cell content is valid JSON
                const content = JSON.parse(newCell.value);
                assert.isObject(content, 'Content should be an object');

                // Verify metadata structure
                assert.property(newCell.metadata, '__deepnotePocket', 'Should have __deepnotePocket metadata');
                assert.equal(newCell.metadata.__deepnotePocket.type, 'big-number', 'Should have big-number type');

                // Verify reveal and selection were set
                assert.isTrue((editor.revealRange as sinon.SinonStub).calledOnce, 'Should reveal the new cell range');
                const revealCall = (editor.revealRange as sinon.SinonStub).firstCall;
                assert.equal(revealCall.args[0].start, 0, 'Should reveal correct range start');
                assert.equal(revealCall.args[0].end, 1, 'Should reveal correct range end');
                assert.equal(revealCall.args[1], 0, 'Should use NotebookEditorRevealType.Default (value 0)');

                // Verify notebook.cell.edit command was executed
                assert.isTrue(
                    executeCommandStub.calledWith('notebook.cell.edit'),
                    'Should execute notebook.cell.edit command'
                );
            });

            test('should add big number block after selection when selection exists', async () => {
                // Setup mocks
                const existingCells = [createMockCell('{}'), createMockCell('{}')];
                const selection = new NotebookRange(0, 1);
                const { editor } = createMockEditor(existingCells, selection);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addBigNumberChartBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();

                // Verify chainWithPendingUpdates was called
                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');

                // Verify a cell was inserted
                assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                const notebookEdit = capturedNotebookEdits![0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');
                assert.equal(notebookEdit.newCells[0].languageId, 'json', 'Should be JSON cell');
            });

            test('should insert at correct position in the middle of notebook', async () => {
                // Setup mocks
                const existingCells = [createMockCell('{}'), createMockCell('{}'), createMockCell('{}')];
                const selection = new NotebookRange(1, 2);
                const { editor } = createMockEditor(existingCells, selection);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addBigNumberChartBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();

                // Verify chainWithPendingUpdates was called
                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');

                // Verify a cell was inserted
                assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                const notebookEdit = capturedNotebookEdits![0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');
                assert.equal(notebookEdit.newCells[0].languageId, 'json', 'Should be JSON cell');
            });

            test('should throw error when no active editor exists', async () => {
                // Setup: no active editor
                Object.defineProperty(window, 'activeNotebookEditor', {
                    value: undefined,
                    configurable: true,
                    writable: true
                });

                // Call the method and expect rejection
                await assert.isRejected(
                    commandListener.addBigNumberChartBlock(),
                    Error,
                    'No active notebook editor found'
                );
            });

            test('should throw error when chainWithPendingUpdates fails', async () => {
                // Setup mocks
                const { editor } = createMockEditor([], undefined);
                Object.defineProperty(window, 'activeNotebookEditor', {
                    value: editor,
                    configurable: true,
                    writable: true
                });

                // Mock chainWithPendingUpdates to return false
                sandbox.stub(notebookUpdater, 'chainWithPendingUpdates').resolves(false);

                // Call the method and expect rejection
                await assert.isRejected(
                    commandListener.addBigNumberChartBlock(),
                    Error,
                    'Failed to insert big number chart block'
                );
            });
        });
    });
});
