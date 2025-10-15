import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
import { VisualizationBlockConverter } from './visualizationBlockConverter';

suite('VisualizationBlockConverter', () => {
    let converter: VisualizationBlockConverter;

    setup(() => {
        converter = new VisualizationBlockConverter();
    });

    suite('canConvert', () => {
        test('returns true for visualization type', () => {
            assert.isTrue(converter.canConvert('visualization'));
        });

        test('canConvert ignores case', () => {
            assert.isTrue(converter.canConvert('VISUALIZATION'));
            assert.isTrue(converter.canConvert('Visualization'));
            assert.isTrue(converter.canConvert('ViSuAlIzAtIoN'));
        });

        test('returns false for non-visualization types', () => {
            assert.isFalse(converter.canConvert('code'));
            assert.isFalse(converter.canConvert('markdown'));
            assert.isFalse(converter.canConvert('text-cell-h1'));
            assert.isFalse(converter.canConvert('unknown'));
        });
    });

    suite('getSupportedTypes', () => {
        test('returns array with visualization type', () => {
            const types = converter.getSupportedTypes();

            assert.deepStrictEqual(types, ['visualization']);
        });
    });

    suite('convertToCell', () => {
        test('converts visualization block with metadata to Python code', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'date_df',
                    deepnote_visualization_spec: {
                        layer: [{ mark: 'bar' }],
                        config: { legend: { disable: false } }
                    }
                }
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.include(cell.value, '_dntk.DeepnoteChart(');
            assert.include(cell.value, 'date_df');
            assert.include(cell.value, '"layer"');
            assert.include(cell.value, '"mark": "bar"');
            assert.include(cell.value, 'False');
            assert.notInclude(cell.value, 'false');
        });

        test('converts boolean values to Python format', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'df',
                    deepnote_visualization_spec: {
                        enabled: true,
                        disabled: false,
                        nullValue: null
                    }
                }
            };

            const cell = converter.convertToCell(block);

            assert.include(cell.value, 'True');
            assert.include(cell.value, 'False');
            assert.include(cell.value, 'None');
            assert.notInclude(cell.value, 'true');
            assert.notInclude(cell.value, 'false');
            assert.notInclude(cell.value, 'null');
        });

        test('removes usermeta field from spec', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'df',
                    deepnote_visualization_spec: {
                        mark: 'bar',
                        usermeta: {
                            shouldBeRemoved: true
                        }
                    }
                }
            };

            const cell = converter.convertToCell(block);

            assert.notInclude(cell.value, 'usermeta');
            assert.notInclude(cell.value, 'shouldBeRemoved');
            assert.include(cell.value, '"mark": "bar"');
        });

        test('handles missing variable name with default', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_visualization_spec: {
                        layer: []
                    }
                }
            };

            const cell = converter.convertToCell(block);

            assert.include(cell.value, 'df,');
        });

        test('handles missing visualization spec with empty object', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'my_df'
                }
            };

            const cell = converter.convertToCell(block);

            assert.include(cell.value, 'my_df');
            assert.include(cell.value, '{}');
        });

        test('handles missing metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.include(cell.value, '_dntk.DeepnoteChart(');
            assert.include(cell.value, 'df');
            assert.include(cell.value, '{}');
        });

        test('generates properly formatted Python code', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'sales_data',
                    deepnote_visualization_spec: {
                        title: 'Sales Chart',
                        mark: 'line'
                    }
                }
            };

            const cell = converter.convertToCell(block);

            const expectedPattern = /_dntk\.DeepnoteChart\(\s+sales_data,\s+\{/;

            assert.match(cell.value, expectedPattern);
        });

        test('handles complex nested visualization spec', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'df',
                    deepnote_visualization_spec: {
                        layer: [
                            {
                                layer: [
                                    {
                                        mark: { type: 'bar', color: '#2266D3' },
                                        encoding: {
                                            x: { type: 'temporal', field: 'date' },
                                            y: { type: 'quantitative', aggregate: 'count' }
                                        }
                                    }
                                ]
                            }
                        ],
                        config: { legend: { disable: false } }
                    }
                }
            };

            const cell = converter.convertToCell(block);

            assert.include(cell.value, '"layer"');
            assert.include(cell.value, '"mark"');
            assert.include(cell.value, '"encoding"');
            assert.include(cell.value, '"config"');
        });
    });

    suite('applyChangesToBlock', () => {
        test('sets content to empty string', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'df',
                    deepnote_visualization_spec: {}
                }
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '_dntk.DeepnoteChart(df, {})', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });

        test('does not modify metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'my_df',
                    deepnote_visualization_spec: { mark: 'bar' },
                    custom_field: 'custom_value'
                }
            };
            const cell = new NotebookCellData(
                NotebookCellKind.Code,
                '_dntk.DeepnoteChart(different_df, {"mark": "line"})',
                'python'
            );

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_name, 'my_df');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, { mark: 'bar' });
            assert.strictEqual(block.metadata?.custom_field, 'custom_value');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                executionCount: 10,
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'df',
                    deepnote_visualization_spec: {}
                },
                outputs: [],
                sortingKey: 'a0',
                type: 'visualization'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'any content', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'visualization');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.strictEqual(block.executionCount, 10);
        });
    });

    suite('round-trip conversion', () => {
        test('preserves metadata through conversion cycle', () => {
            const originalBlock: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'visualization',
                metadata: {
                    deepnote_variable_name: 'sales_df',
                    deepnote_visualization_spec: {
                        layer: [{ mark: 'bar' }],
                        config: { legend: { disable: false } }
                    },
                    execution_start: 1234567890,
                    execution_millis: 42
                }
            };

            const cell = converter.convertToCell(originalBlock);

            const newBlock: DeepnoteBlock = {
                blockGroup: originalBlock.blockGroup,
                content: 'temp',
                id: originalBlock.id,
                sortingKey: originalBlock.sortingKey,
                type: originalBlock.type,
                metadata: originalBlock.metadata
            };

            converter.applyChangesToBlock(newBlock, cell);

            assert.strictEqual(newBlock.content, '');
            assert.deepStrictEqual(newBlock.metadata, originalBlock.metadata);
        });
    });
});
