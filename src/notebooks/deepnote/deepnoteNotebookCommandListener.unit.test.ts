import { assert } from 'chai';
import * as sinon from 'sinon';
import { when, reset, anything, deepEqual, mock, instance, verify } from 'ts-mockito';
import {
    NotebookCell,
    NotebookDocument,
    NotebookEditor,
    NotebookRange,
    NotebookCellKind,
    NotebookCellData,
    WorkspaceEdit
} from 'vscode';

import {
    DeepnoteNotebookCommandListener,
    getNextDeepnoteVariableName,
    InputBlockType
} from './deepnoteNotebookCommandListener';
import { formatInputBlockCellContent, getInputBlockLanguage } from './inputBlockContentFormatter';
import { ITelemetryService } from '../../platform/analytics/types';
import { IConfigurationService, IDisposable } from '../../platform/common/types';
import * as notebookUpdater from '../../kernels/execution/notebookUpdater';
import { WrappedError } from '../../platform/errors/types';
import { DATAFRAME_SQL_INTEGRATION_ID } from '../../platform/notebooks/deepnote/integrationTypes';
import { mockedVSCodeNamespaces } from '../../test/vscode-mock';
import { createMockCell, createMockNotebookWithCells } from './deepnoteTestHelpers';

suite('DeepnoteNotebookCommandListener', () => {
    let commandListener: DeepnoteNotebookCommandListener;
    let disposables: IDisposable[];
    let sandbox: sinon.SinonSandbox;
    let mockConfigService: IConfigurationService;
    let mockTelemetryService: ITelemetryService;

    function createMockConfigService(): IConfigurationService {
        return {
            getSettings: sinon.stub().returns({}),
            updateSetting: sinon.stub().resolves(),
            updateSectionSetting: sinon.stub().resolves()
        } as unknown as IConfigurationService;
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        disposables = [];
        mockConfigService = createMockConfigService();
        mockTelemetryService = mock<ITelemetryService>();
        commandListener = new DeepnoteNotebookCommandListener(
            instance(mockTelemetryService),
            mockConfigService,
            disposables
        );
    });

    teardown(() => {
        sandbox.restore();
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
            const commandListener2 = new DeepnoteNotebookCommandListener(
                instance(mockTelemetryService),
                createMockConfigService(),
                disposables2
            );
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
                cells: [
                    createMockCell({ text: '{ "some_other_field": "value" }' }),
                    createMockCell({ text: '{ "data": "test" }' })
                ],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should return input_2 when input_1 exists in content JSON',
                cells: [createMockCell({ text: '{ "deepnote_variable_name": "input_1" }' })],
                prefix: 'input',
                expected: 'input_2'
            },
            {
                description: 'should return input_3 when input_1 and input_2 exist',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "input_1" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_2" }' })
                ],
                prefix: 'input',
                expected: 'input_3'
            },
            {
                description: 'should return input_6 when max suffix is input_5',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "input_1" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_5" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_3" }' })
                ],
                prefix: 'input',
                expected: 'input_6'
            },
            {
                description: 'should return input_1 when variable names have no numeric suffix',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "my_variable" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "another_var" }' })
                ],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should return input_11 when input_10 exists',
                cells: [createMockCell({ text: '{ "deepnote_variable_name": "input_10" }' })],
                prefix: 'input',
                expected: 'input_11'
            },
            {
                description: 'should extract variable name from metadata',
                cells: [
                    createMockCell({
                        text: '{}',
                        metadata: { __deepnotePocket: { deepnote_variable_name: 'input_7' } }
                    })
                ],
                prefix: 'input',
                expected: 'input_8'
            },
            {
                description: 'should handle both content and metadata variable names',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "input_2" }' }),
                    createMockCell({
                        text: '{}',
                        metadata: { __deepnotePocket: { deepnote_variable_name: 'input_5' } }
                    }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_3" }' })
                ],
                prefix: 'input',
                expected: 'input_6'
            },
            {
                description: 'should handle mixed variable names with and without numbers',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "my_custom_input" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_4" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "another_variable" }' })
                ],
                prefix: 'input',
                expected: 'input_5'
            },
            {
                description: 'should handle invalid JSON gracefully',
                cells: [
                    createMockCell({ text: 'not valid json' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_3" }' })
                ],
                prefix: 'input',
                expected: 'input_4'
            },
            {
                description: 'should handle cells with both content and metadata, preferring the highest',
                cells: [
                    createMockCell({
                        text: '{ "deepnote_variable_name": "input_2" }',
                        metadata: { __deepnotePocket: { deepnote_variable_name: 'input_8' } }
                    })
                ],
                prefix: 'input',
                expected: 'input_9'
            },
            {
                description: 'should handle non-numeric suffixes in variable names',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "input_abc" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_5" }' })
                ],
                prefix: 'input',
                expected: 'input_6'
            },
            {
                description: 'should return input_1 when only zero-suffixed names exist',
                cells: [createMockCell({ text: '{ "deepnote_variable_name": "input_0" }' })],
                prefix: 'input',
                expected: 'input_1'
            },
            {
                description: 'should handle large numbers correctly',
                cells: [createMockCell({ text: '{ "deepnote_variable_name": "input_999" }' })],
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
                cells: [createMockCell({ text: '{ "deepnote_variable_name": "df_1" }' })],
                prefix: 'df',
                expected: 'df_2'
            },
            {
                description: 'should return df_5 when df_4 exists and ignore input_ variables',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "df_4" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_10" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "query_7" }' })
                ],
                prefix: 'df',
                expected: 'df_5'
            },
            {
                description: 'should return df_1 when only input_ variables exist',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "input_5" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_10" }' })
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
                    createMockCell({ text: '{ "deepnote_variable_name": "query_1" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "query_2" }' })
                ],
                prefix: 'query',
                expected: 'query_3'
            },
            {
                description: 'should return query_8 when max suffix is query_7 and ignore other prefixes',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "query_7" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "df_100" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_50" }' })
                ],
                prefix: 'query',
                expected: 'query_8'
            },

            // Mixed prefix tests
            {
                description: 'should only count matching prefix when multiple prefixes exist',
                cells: [
                    createMockCell({ text: '{ "deepnote_variable_name": "input_5" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "df_3" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "query_2" }' }),
                    createMockCell({ text: '{ "deepnote_variable_name": "input_8" }' })
                ],
                prefix: 'input',
                expected: 'input_9'
            },
            {
                description: 'should handle metadata with different prefix',
                cells: [
                    createMockCell({
                        text: '{}',
                        metadata: { __deepnotePocket: { deepnote_variable_name: 'df_15' } }
                    }),
                    createMockCell({ text: '{ "deepnote_variable_name": "df_20" }' })
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
            // Reset the ts-mockito mocks
            reset(mockedVSCodeNamespaces.window);
            reset(mockedVSCodeNamespaces.commands);
        });

        /**
         * Helper to create NotebookCellData with metadata, for seeding createMockEditor.
         */
        function createMockCellData(content: string, metadata?: Record<string, any>): NotebookCellData {
            const cell = new NotebookCellData(NotebookCellKind.Code, content, 'json');
            if (metadata != null) {
                cell.metadata = metadata;
            }
            return cell;
        }

        /**
         * Helper to create mock NotebookEditor and NotebookDocument.
         *
         * Built on createMockNotebookWithCells rather than createMockedNotebookDocument because the
         * latter drops NotebookCellData.metadata, which the block commands read.
         */
        function createMockEditor(
            cellDataArray: NotebookCellData[],
            selection?: NotebookRange
        ): {
            // revealRange is narrowed to the stub it actually is, so assertions on it need no cast.
            editor: NotebookEditor & { revealRange: sinon.SinonStub };
            document: NotebookDocument;
        } {
            const { notebook: document } = createMockNotebookWithCells(
                cellDataArray.map((data) => ({
                    kind: data.kind,
                    languageId: data.languageId,
                    text: data.value,
                    metadata: data.metadata
                }))
            );

            const editorSelection =
                selection != null ? selection : new NotebookRange(0, cellDataArray.length > 0 ? 1 : 0);

            const editor: NotebookEditor & { revealRange: sinon.SinonStub } = {
                notebook: document,
                selection: editorSelection,
                selections: [editorSelection],
                visibleRanges: [],
                revealRange: sandbox.stub()
            };

            return { editor, document };
        }

        function mockNotebookUpdateAndExecute(editor: NotebookEditor) {
            // Use ts-mockito to mock the activeNotebookEditor
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

            let capturedNotebookEdits: any[] | null = null;

            // Mock chainWithPendingUpdates to capture the edit and resolve immediately
            // Use notebookUpdaterUtils object which is mutable and can be stubbed in ESM
            const chainStub = sandbox
                .stub(notebookUpdater.notebookUpdaterUtils, 'chainWithPendingUpdates')
                .callsFake((_doc: NotebookDocument, callback: (edit: WorkspaceEdit) => void) => {
                    const edit = new WorkspaceEdit();
                    // Stub the set method to capture the notebook edits
                    sandbox.stub(edit, 'set').callsFake((_uri, edits) => {
                        capturedNotebookEdits = edits as any[];
                    });
                    callback(edit);
                    return Promise.resolve(true);
                });

            // Mock commands.executeCommand using ts-mockito (ESM-compatible)
            when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenResolve(undefined as any);
            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve(undefined as any);

            return {
                chainStub,
                getCapturedNotebookEdits: () => capturedNotebookEdits
            };
        }

        teardown(() => {
            reset(mockedVSCodeNamespaces.commands);
        });

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
                existingCells: [createMockCellData('{}')],
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
                    createMockCellData('{ "deepnote_variable_name": "input_1" }'),
                    createMockCellData('{ "deepnote_variable_name": "input_2" }')
                ],
                selection: new NotebookRange(1, 2),
                expectedInsertIndex: 2,
                expectedVariableName: 'input_3',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should insert at selection.end when selection is in the middle',
                blockType: 'input-text',
                existingCells: [createMockCellData('{}'), createMockCellData('{}'), createMockCellData('{}')],
                selection: new NotebookRange(1, 2),
                expectedInsertIndex: 2,
                expectedVariableName: 'input_1',
                expectedMetadataKeys: ['deepnote_variable_name', 'deepnote_input_label', 'deepnote_variable_value']
            },
            {
                description: 'should handle large variable numbers correctly',
                blockType: 'input-text',
                existingCells: [createMockCellData('{ "deepnote_variable_name": "input_99" }')],
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

                    const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

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

                    // Verify language mode matches the expected language for this block type
                    const expectedLanguage = getInputBlockLanguage(blockType);
                    assert.equal(newCell.languageId, expectedLanguage, `Should have ${expectedLanguage} language`);

                    // Verify cell content is formatted correctly using the formatter
                    const expectedContent = formatInputBlockCellContent(blockType, newCell.metadata);
                    assert.equal(newCell.value, expectedContent, 'Cell content should match formatted content');

                    // Verify metadata structure
                    assert.property(newCell.metadata, '__deepnotePocket', 'Should have __deepnotePocket metadata');
                    assert.equal(newCell.metadata.__deepnotePocket.type, blockType, 'Should have correct block type');
                    assert.equal(
                        newCell.metadata.__deepnotePocket.deepnote_variable_name,
                        expectedVariableName,
                        'Metadata should have correct variable name'
                    );

                    // Verify all expected metadata keys are present in __deepnotePocket
                    expectedMetadataKeys.forEach((key) => {
                        assert.property(newCell.metadata.__deepnotePocket, key, `Metadata should have ${key} property`);
                    });

                    // Verify metadata is also at the top level
                    assert.equal(
                        newCell.metadata.deepnote_variable_name,
                        expectedVariableName,
                        'Top-level metadata should have correct variable name'
                    );
                    expectedMetadataKeys.forEach((key) => {
                        assert.property(newCell.metadata, key, `Top-level metadata should have ${key} property`);
                    });

                    // Verify reveal and selection were set
                    assert.isTrue(editor.revealRange.calledOnce, 'Should reveal the new cell range');
                    const revealCall = editor.revealRange.firstCall;
                    assert.equal(revealCall.args[0].start, expectedInsertIndex, 'Should reveal correct range start');
                    assert.equal(revealCall.args[0].end, expectedInsertIndex + 1, 'Should reveal correct range end');
                });
            }
        );

        test('should do nothing when no active editor exists', async () => {
            // Setup: no active editor
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

            const chainStub = sinon.stub();
            sandbox.replace(notebookUpdater.notebookUpdaterUtils, 'chainWithPendingUpdates', chainStub);

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
            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

            // Mock chainWithPendingUpdates to reject
            const chainStub = sinon.stub().rejects(new Error('Test error'));
            sandbox.replace(notebookUpdater.notebookUpdaterUtils, 'chainWithPendingUpdates', chainStub);

            // Call the method - should not throw
            await assert.isRejected(commandListener.addInputBlock('input-text'), Error, 'Test error');

            // Verify chainWithPendingUpdates was called
            assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called');
        });

        suite('addSqlBlock', () => {
            test('should add SQL block at the end when no selection exists', async () => {
                // Setup mocks
                const { editor, document } = createMockEditor([], undefined);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

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
                    DATAFRAME_SQL_INTEGRATION_ID,
                    'Should have correct sql integration id'
                );

                // Verify reveal and selection were set
                assert.isTrue(editor.revealRange.calledOnce, 'Should reveal the new cell range');
                const revealCall = editor.revealRange.firstCall;
                assert.equal(revealCall.args[0].start, 0, 'Should reveal correct range start');
                assert.equal(revealCall.args[0].end, 1, 'Should reveal correct range end');
                assert.equal(revealCall.args[1], 0, 'Should use NotebookEditorRevealType.Default (value 0)');
            });

            test('should add SQL block after selection when selection exists', async () => {
                // Setup mocks
                const existingCells = [createMockCellData('{}'), createMockCellData('{}')];
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
                    createMockCellData('{ "deepnote_variable_name": "df_1" }'),
                    createMockCellData('{ "deepnote_variable_name": "df_2" }')
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
                    createMockCellData('{ "deepnote_variable_name": "input_10" }'),
                    createMockCellData('{ "deepnote_variable_name": "df_2" }')
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
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

                // Call the method and expect rejection
                await assert.isRejected(commandListener.addSqlBlock(), Error, 'No active notebook editor found');
            });

            test('should throw error when chainWithPendingUpdates fails', async () => {
                // Setup mocks
                const { editor } = createMockEditor([], undefined);
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

                // Mock chainWithPendingUpdates to return false
                sandbox.replace(
                    notebookUpdater.notebookUpdaterUtils,
                    'chainWithPendingUpdates',
                    sinon.stub().resolves(false)
                );

                // Call the method and expect rejection
                await assert.isRejected(commandListener.addSqlBlock(), Error, 'Failed to insert SQL block');
            });
        });

        suite('addAgentBlock', () => {
            function insertedCell(getCapturedNotebookEdits: () => any[] | null) {
                const edits = getCapturedNotebookEdits()!;
                assert.equal(edits.length, 1, 'Should have one notebook edit');

                const notebookEdit = edits[0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');

                return notebookEdit.newCells[0];
            }

            test('should add an empty plaintext agent block at the end when no selection exists', async () => {
                const { editor, document } = createMockEditor([], undefined);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');
                assert.equal(chainStub.firstCall.args[0], document, 'Should be called with correct document');

                const newCell = insertedCell(getCapturedNotebookEdits);
                assert.equal(newCell.kind, NotebookCellKind.Code, 'Should be a code cell');
                assert.equal(newCell.languageId, 'plaintext', 'Should have plaintext language');
                assert.equal(newCell.value, '', 'Should have empty content');
                assert.equal(newCell.metadata.__deepnotePocket.type, 'agent', 'Should have agent pocket type');

                assert.isTrue(editor.revealRange.calledOnce, 'Should reveal the new cell range');
                const revealCall = editor.revealRange.firstCall;
                assert.equal(revealCall.args[0].start, 0, 'Should reveal correct range start');
                assert.equal(revealCall.args[0].end, 1, 'Should reveal correct range end');
            });

            test('should append the agent block to the end even when an earlier cell is selected', async () => {
                // Catches: a selection-relative insert, which drops the agent between the user's
                // cells and then interleaves its generated cells through the rest of the notebook.
                const existingCells = [createMockCellData('{}'), createMockCellData('{}'), createMockCellData('{}')];
                const { editor, document } = createMockEditor(existingCells, new NotebookRange(0, 1));
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                insertedCell(getCapturedNotebookEdits);
                assert.equal(chainStub.firstCall.args[0], document, 'Should edit the active document');

                const revealCall = editor.revealRange.firstCall;
                assert.equal(revealCall.args[0].start, 3, 'Should append to the end, not below the selection');
                assert.equal(revealCall.args[0].end, 4, 'Should select only the new cell');
            });

            test('should mint a block id under both keys so runs keep a stable owner', async () => {
                // Catches: an id-less agent block, which gets a fresh random id on every
                // convertCellToBlock — its generated cells would never be matched back to it.
                const { editor } = createMockEditor([], undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                const { metadata } = insertedCell(getCapturedNotebookEdits);
                assert.match(metadata.id, /^[0-9a-f]{32}$/, 'Should mint a 32-char hex block id');
                assert.equal(metadata.__deepnoteBlockId, metadata.id, 'Backup id key must match id');
            });

            test('should give each notebook its own agent block id', async () => {
                // Catches: a hoisted/constant id, which would make two agent blocks fight over the
                // same generated cells. Two notebooks, because one notebook only ever gets one block.
                const { editor } = createMockEditor([], undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();
                const first = insertedCell(getCapturedNotebookEdits).metadata.id;

                const { editor: otherEditor } = createMockEditor([], undefined);
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(otherEditor);

                await commandListener.addAgentBlock();
                const second = insertedCell(getCapturedNotebookEdits).metadata.id;

                assert.notEqual(first, second, 'Each agent block needs its own id');
            });

            test('should persist the default model rather than leaving the key absent', async () => {
                // Catches: omitting deepnote_agent_model, which reaches openai() as undefined.
                const { editor } = createMockEditor([], undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                const { metadata } = insertedCell(getCapturedNotebookEdits);
                assert.equal(metadata.deepnote_agent_model, 'auto', 'Should persist the auto default');
            });

            test('should refuse a second agent block and leave the notebook untouched', async () => {
                const { editor } = createMockEditor([
                    createMockCellData('existing agent', { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' }),
                    createMockCellData('user code')
                ]);
                const { chainStub } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                assert.isFalse(chainStub.called, 'Must not edit a notebook that already has an agent block');
                verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
                assert.isFalse(editor.revealRange.called, 'Must not reveal anything');
                verify(mockTelemetryService.trackEvent(anything())).never();
            });

            test('should report the added agent block to analytics', async () => {
                const { editor } = createMockEditor([], undefined);
                mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                verify(
                    mockTelemetryService.trackEvent(
                        deepEqual({ eventName: 'add_block', properties: { blockType: 'agent', isEphemeral: false } })
                    )
                ).once();
            });

            test('should insert only one agent block when two invocations race', async () => {
                // Catches: an existence check that runs before the queued update — both invocations
                // pass it while neither edit has applied yet.
                const { editor, document } = createMockEditor([], undefined);
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);
                when(mockedVSCodeNamespaces.commands.executeCommand(anything())).thenResolve(undefined as any);

                const cells = document.getCells();
                const insertedCells: NotebookCellData[] = [];
                let pending: Promise<unknown> = Promise.resolve();

                // Mirrors chainWithPendingUpdates: a callback runs only once the previous edit applied.
                sandbox
                    .stub(notebookUpdater.notebookUpdaterUtils, 'chainWithPendingUpdates')
                    .callsFake((_doc: NotebookDocument, callback: (edit: WorkspaceEdit) => void) => {
                        const applied = pending.then(() => {
                            const edit = new WorkspaceEdit();
                            sandbox.stub(edit, 'set').callsFake((_uri, edits) => {
                                for (const newCell of (edits[0] as any).newCells as NotebookCellData[]) {
                                    insertedCells.push(newCell);
                                    cells.push(
                                        createMockCell({
                                            metadata: newCell.metadata,
                                            index: cells.length,
                                            notebook: document
                                        })
                                    );
                                }
                            });
                            callback(edit);

                            return true;
                        });
                        pending = applied;

                        return applied;
                    });

                await Promise.all([commandListener.addAgentBlock(), commandListener.addAgentBlock()]);

                assert.equal(insertedCells.length, 1, 'Should insert exactly one agent block');
                assert.equal(cells.length, 1, 'Notebook should end up with a single cell');
            });

            test('should still add the block when other cells carry no agent pocket', async () => {
                // Catches: a guard that trips on any cell, blocking the first agent block outright.
                const { editor } = createMockEditor([
                    createMockCellData('user code', { __deepnotePocket: { type: 'code' }, id: 'code-block-1' }),
                    createMockCellData('scratch', { is_ephemeral: true, agent_source_block_id: 'agent-block-1' })
                ]);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                await commandListener.addAgentBlock();

                assert.isTrue(chainStub.calledOnce, 'Should insert the first agent block');
                assert.equal(insertedCell(getCapturedNotebookEdits).metadata.__deepnotePocket.type, 'agent');
                verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).never();
            });

            test('should throw error when no active editor exists', async () => {
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

                await assert.isRejected(commandListener.addAgentBlock(), Error, 'No active notebook editor found');
            });

            test('should throw error when chainWithPendingUpdates fails', async () => {
                const { editor } = createMockEditor([], undefined);
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

                sandbox.replace(
                    notebookUpdater.notebookUpdaterUtils,
                    'chainWithPendingUpdates',
                    sinon.stub().resolves(false)
                );

                await assert.isRejected(commandListener.addAgentBlock(), Error, 'Failed to insert agent block');
            });
        });

        suite('addBigNumberChartBlock', () => {
            test('should add big number block at the end when no selection exists', async () => {
                // Setup mocks
                const { editor, document } = createMockEditor([], undefined);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

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
                assert.isTrue(editor.revealRange.calledOnce, 'Should reveal the new cell range');
                const revealCall = editor.revealRange.firstCall;
                assert.equal(revealCall.args[0].start, 0, 'Should reveal correct range start');
                assert.equal(revealCall.args[0].end, 1, 'Should reveal correct range end');
                assert.equal(revealCall.args[1], 0, 'Should use NotebookEditorRevealType.Default (value 0)');
            });

            test('should add big number block after selection when selection exists', async () => {
                // Setup mocks
                const existingCells = [createMockCellData('{}'), createMockCellData('{}')];
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
                const existingCells = [createMockCellData('{}'), createMockCellData('{}'), createMockCellData('{}')];
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
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

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
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

                // Mock chainWithPendingUpdates to return false
                sandbox.replace(
                    notebookUpdater.notebookUpdaterUtils,
                    'chainWithPendingUpdates',
                    sinon.stub().resolves(false)
                );

                // Call the method and expect rejection
                await assert.isRejected(
                    commandListener.addBigNumberChartBlock(),
                    Error,
                    'Failed to insert big number chart block'
                );
            });
        });

        suite('addChartBlock', () => {
            test('should add chart block at the end when no selection exists', async () => {
                // Setup mocks
                const { editor, document } = createMockEditor([], undefined);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addChartBlock();

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

                // Verify cell content is valid JSON with correct structure
                const content = JSON.parse(newCell.value);
                assert.equal(content.variable, 'df_1', 'Should have correct variable name');
                assert.property(content, 'spec', 'Should have spec property');
                assert.property(content, 'filters', 'Should have filters property');

                // Verify the spec has the correct Vega-Lite structure
                assert.equal(content.spec.mark, 'line', 'Should be a line chart');
                assert.equal(
                    content.spec.$schema,
                    'https://vega.github.io/schema/vega-lite/v5.json',
                    'Should have Vega-Lite schema'
                );
                assert.deepStrictEqual(content.spec.data, { values: [] }, 'Should have empty data array');
                assert.property(content.spec, 'encoding', 'Should have encoding property');
                assert.property(content.spec.encoding, 'x', 'Should have x encoding');
                assert.property(content.spec.encoding, 'y', 'Should have y encoding');

                // Verify metadata structure
                assert.property(newCell.metadata, '__deepnotePocket', 'Should have __deepnotePocket metadata');
                assert.equal(newCell.metadata.__deepnotePocket.type, 'visualization', 'Should have visualization type');

                // Verify reveal and selection were set
                assert.isTrue(editor.revealRange.calledOnce, 'Should reveal the new cell range');
                const revealCall = editor.revealRange.firstCall;
                assert.equal(revealCall.args[0].start, 0, 'Should reveal correct range start');
                assert.equal(revealCall.args[0].end, 1, 'Should reveal correct range end');
                assert.equal(revealCall.args[1], 0, 'Should use NotebookEditorRevealType.Default (value 0)');
            });

            test('should add chart block after selection when selection exists', async () => {
                // Setup mocks
                const existingCells = [createMockCellData('{}'), createMockCellData('{}')];
                const selection = new NotebookRange(0, 1);
                const { editor } = createMockEditor(existingCells, selection);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addChartBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();

                // Verify chainWithPendingUpdates was called
                assert.isTrue(chainStub.calledOnce, 'chainWithPendingUpdates should be called once');

                // Verify a cell was inserted
                assert.isNotNull(capturedNotebookEdits, 'Notebook edits should be captured');
                const notebookEdit = capturedNotebookEdits![0] as any;
                assert.equal(notebookEdit.newCells.length, 1, 'Should insert one cell');
                assert.equal(notebookEdit.newCells[0].languageId, 'json', 'Should be JSON cell');
            });

            test('should use hardcoded variable name df_1', async () => {
                // Setup mocks with existing df variables
                const existingCells = [
                    createMockCellData('{ "deepnote_variable_name": "df_1" }'),
                    createMockCellData('{ "variable": "df_2" }')
                ];
                const { editor } = createMockEditor(existingCells, undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addChartBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();
                const notebookEdit = capturedNotebookEdits![0] as any;
                const newCell = notebookEdit.newCells[0];

                // Verify variable name is always df_1
                const content = JSON.parse(newCell.value);
                assert.equal(content.variable, 'df_1', 'Should always use df_1');
            });

            test('should always use df_1 regardless of existing variables', async () => {
                // Setup mocks with various existing variables
                const existingCells = [
                    createMockCellData('{ "deepnote_variable_name": "input_10" }'),
                    createMockCellData('{ "deepnote_variable_name": "df_5" }'),
                    createMockCellData('{ "variable": "df_2" }')
                ];
                const { editor } = createMockEditor(existingCells, undefined);
                const { getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addChartBlock();

                const capturedNotebookEdits = getCapturedNotebookEdits();
                const notebookEdit = capturedNotebookEdits![0] as any;
                const newCell = notebookEdit.newCells[0];

                // Verify variable name is always df_1
                const content = JSON.parse(newCell.value);
                assert.equal(content.variable, 'df_1', 'Should always use df_1');
            });

            test('should insert at correct position in the middle of notebook', async () => {
                // Setup mocks
                const existingCells = [createMockCellData('{}'), createMockCellData('{}'), createMockCellData('{}')];
                const selection = new NotebookRange(1, 2);
                const { editor } = createMockEditor(existingCells, selection);
                const { chainStub, getCapturedNotebookEdits } = mockNotebookUpdateAndExecute(editor);

                // Call the method
                await commandListener.addChartBlock();

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
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(undefined);

                // Call the method and expect rejection
                await assert.isRejected(
                    commandListener.addChartBlock(),
                    WrappedError,
                    'No active notebook editor found'
                );
            });

            test('should throw error when chainWithPendingUpdates fails', async () => {
                // Setup mocks
                const { editor } = createMockEditor([], undefined);
                when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(editor);

                // Mock chainWithPendingUpdates to return false
                sandbox.replace(
                    notebookUpdater.notebookUpdaterUtils,
                    'chainWithPendingUpdates',
                    sinon.stub().resolves(false)
                );

                // Call the method and expect rejection
                await assert.isRejected(commandListener.addChartBlock(), WrappedError, 'Failed to insert chart block');
            });
        });
    });
});
