import { assert } from 'chai';
import { DeepnoteNotebookCommandListener, getNextDeepnoteVariableName } from './deepnoteNotebookCommandListener';
import { IDisposable } from '../../platform/common/types';
import { NotebookCell } from 'vscode';

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
                        __deepnotePocket: { variableName: 'input_7' }
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
                        __deepnotePocket: { variableName: 'input_5' }
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
                        __deepnotePocket: { variableName: 'input_8' }
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
                        __deepnotePocket: { variableName: 'df_15' }
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
});
