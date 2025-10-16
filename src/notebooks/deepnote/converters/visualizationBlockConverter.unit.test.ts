import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
import { VisualizationBlockConverter } from './visualizationBlockConverter';

suite('VisualizationBlockConverter', () => {
    let converter: VisualizationBlockConverter;

    setup(() => {
        converter = new VisualizationBlockConverter();
    });

    suite('canConvert and getSupportedTypes', () => {
        test('returns true for visualization (case-insensitive) and false for other types', () => {
            assert.isTrue(converter.canConvert('visualization'));
            assert.isTrue(converter.canConvert('VISUALIZATION'));
            assert.isTrue(converter.canConvert('Visualization'));
            assert.isFalse(converter.canConvert('code'));
            assert.isFalse(converter.canConvert('markdown'));
            assert.deepStrictEqual(converter.getSupportedTypes(), ['visualization']);
        });
    });

    suite('convertToCell', () => {
        test('converts block with full metadata to properly formatted JSON cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz1',
                type: 'visualization',
                content: '',
                sortingKey: 'a0',
                metadata: {
                    deepnote_variable_name: 'sales_data',
                    deepnote_visualization_spec: {
                        mark: 'bar',
                        encoding: {
                            x: { field: 'category', type: 'nominal' },
                            y: { field: 'value', type: 'quantitative' }
                        }
                    },
                    deepnote_chart_filter: {
                        advancedFilters: [
                            {
                                column: 'status',
                                operator: 'is-equal',
                                comparativeValues: ['active']
                            },
                            {
                                column: 'age',
                                operator: 'greater-than',
                                comparativeValues: ['18']
                            }
                        ]
                    }
                }
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.include(cell.value, '\n');
            assert.match(cell.value, /{\n  "variable"/);

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.variable, 'sales_data');
            assert.deepStrictEqual(config.spec, {
                mark: 'bar',
                encoding: {
                    x: { field: 'category', type: 'nominal' },
                    y: { field: 'value', type: 'quantitative' }
                }
            });
            assert.strictEqual(config.filters.length, 2);
            assert.strictEqual(config.filters[0].column, 'status');
            assert.strictEqual(config.filters[1].operator, 'greater-than');
        });

        test('uses defaults when metadata is missing or empty', () => {
            const blockWithEmptyMetadata: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz2',
                type: 'visualization',
                content: '',
                sortingKey: 'a0',
                metadata: {}
            };

            const blockWithNoMetadata: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz3',
                type: 'visualization',
                content: '',
                sortingKey: 'a0'
            };

            const cell1 = converter.convertToCell(blockWithEmptyMetadata);
            const config1 = JSON.parse(cell1.value);
            assert.strictEqual(config1.variable, 'df');
            assert.deepStrictEqual(config1.spec, {});
            assert.deepStrictEqual(config1.filters, []);

            const cell2 = converter.convertToCell(blockWithNoMetadata);
            const config2 = JSON.parse(cell2.value);
            assert.strictEqual(config2.variable, 'df');
            assert.deepStrictEqual(config2.spec, {});
            assert.deepStrictEqual(config2.filters, []);
        });
    });

    suite('applyChangesToBlock', () => {
        test('updates block metadata from valid JSON and clears content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz1',
                type: 'visualization',
                content: 'old content',
                sortingKey: 'a0',
                metadata: {
                    other_field: 'should be preserved',
                    deepnote_chart_height: 500
                }
            };

            const cell = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify({
                    variable: 'my_data',
                    spec: { mark: 'point' },
                    filters: [
                        { column: 'status', operator: 'is-equal', comparativeValues: ['active'] },
                        { column: 'date', operator: 'between', comparativeValues: ['2023-01-01', '2023-12-31'] }
                    ]
                }),
                'python'
            );

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'my_data');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, { mark: 'point' });
            assert.strictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters?.length, 2);
            assert.strictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters?.[0].column, 'status');
            assert.strictEqual(block.metadata?.other_field, 'should be preserved');
            assert.strictEqual(block.metadata?.deepnote_chart_height, 500);
        });

        test('sets empty values for missing fields in JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz2',
                type: 'visualization',
                content: '',
                sortingKey: 'a0',
                metadata: {
                    deepnote_variable_name: 'existing_var',
                    deepnote_visualization_spec: { mark: 'line' },
                    deepnote_chart_filter: {
                        advancedFilters: [{ column: 'old', operator: 'is-equal', comparativeValues: ['value'] }]
                    },
                    other_field: 'preserved'
                }
            };

            const cellWithOnlyVariable = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify({ variable: 'updated_var', spec: {}, filters: [] }),
                'python'
            );
            converter.applyChangesToBlock(block, cellWithOnlyVariable);
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'updated_var');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, {});
            assert.deepStrictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters, []);
            assert.strictEqual(block.metadata?.other_field, 'preserved');

            const cellWithOnlySpec = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify({ variable: 'var2', spec: { mark: 'bar' }, filters: [] }),
                'python'
            );
            converter.applyChangesToBlock(block, cellWithOnlySpec);
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'var2');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, { mark: 'bar' });
            assert.deepStrictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters, []);
        });

        test('creates metadata and chart_filter objects when they do not exist', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz3',
                type: 'visualization',
                content: '',
                sortingKey: 'a0'
            };

            const cell = new NotebookCellData(
                NotebookCellKind.Code,
                JSON.stringify({
                    variable: 'new_var',
                    spec: { mark: 'area' },
                    filters: [{ column: 'category', operator: 'is-not-null', comparativeValues: [] }]
                }),
                'python'
            );

            converter.applyChangesToBlock(block, cell);

            assert.isDefined(block.metadata);
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'new_var');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, { mark: 'area' });
            assert.isDefined(block.metadata?.deepnote_chart_filter);
            assert.strictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters?.length, 1);
        });

        test('handles invalid, empty, and undefined JSON gracefully', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz4',
                type: 'visualization',
                content: '',
                sortingKey: 'a0',
                metadata: {
                    deepnote_variable_name: 'original',
                    deepnote_visualization_spec: { mark: 'original' },
                    other_field: 'preserved'
                }
            };

            const invalidCell = new NotebookCellData(NotebookCellKind.Code, 'not valid json {', 'python');
            assert.doesNotThrow(() => converter.applyChangesToBlock(block, invalidCell));
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'original');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, { mark: 'original' });
            assert.strictEqual(block.metadata?.other_field, 'preserved');

            const emptyCell = new NotebookCellData(NotebookCellKind.Code, '', 'python');
            converter.applyChangesToBlock(block, emptyCell);
            assert.strictEqual(block.metadata?.deepnote_variable_name, '');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, {});
            assert.deepStrictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters, []);
            assert.strictEqual(block.metadata?.other_field, 'preserved');

            const undefinedCell = new NotebookCellData(NotebookCellKind.Code, '', 'python');
            undefinedCell.value = undefined as unknown as string;
            converter.applyChangesToBlock(block, undefinedCell);
            assert.strictEqual(block.metadata?.deepnote_variable_name, '');
            assert.deepStrictEqual(block.metadata?.deepnote_visualization_spec, {});
            assert.deepStrictEqual(block.metadata?.deepnote_chart_filter?.advancedFilters, []);
            assert.strictEqual(block.metadata?.other_field, 'preserved');
        });
    });

    suite('round trip conversion', () => {
        test('block -> cell -> block preserves data', () => {
            const originalBlock: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'viz1',
                type: 'visualization',
                content: '',
                sortingKey: 'a0',
                metadata: {
                    deepnote_variable_name: 'sales_data',
                    deepnote_visualization_spec: {
                        mark: 'bar',
                        encoding: {
                            x: { field: 'category', type: 'nominal' },
                            y: { field: 'value', type: 'quantitative' }
                        }
                    },
                    deepnote_chart_filter: {
                        advancedFilters: [
                            {
                                column: 'status',
                                operator: 'is-equal',
                                comparativeValues: ['active']
                            }
                        ]
                    },
                    deepnote_chart_height: 400
                }
            };

            const cell = converter.convertToCell(originalBlock);

            const roundTripBlock: DeepnoteBlock = {
                blockGroup: originalBlock.blockGroup,
                id: originalBlock.id,
                type: originalBlock.type,
                content: originalBlock.content,
                sortingKey: originalBlock.sortingKey,
                metadata: { ...originalBlock.metadata }
            };

            converter.applyChangesToBlock(roundTripBlock, cell);

            assert.strictEqual(
                roundTripBlock.metadata?.deepnote_variable_name,
                originalBlock.metadata?.deepnote_variable_name
            );
            assert.deepStrictEqual(
                roundTripBlock.metadata?.deepnote_visualization_spec,
                originalBlock.metadata?.deepnote_visualization_spec
            );
            assert.deepStrictEqual(
                roundTripBlock.metadata?.deepnote_chart_filter?.advancedFilters,
                originalBlock.metadata?.deepnote_chart_filter?.advancedFilters
            );
        });
    });
});
