import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../../../platform/deepnote/deepnoteTypes';
import { ChartBigNumberBlockConverter } from './chartBigNumberBlockConverter';
import { DEEPNOTE_VSCODE_RAW_CONTENT_KEY } from './constants';

suite('ChartBigNumberBlockConverter', () => {
    let converter: ChartBigNumberBlockConverter;

    setup(() => {
        converter = new ChartBigNumberBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts percentage change comparison block to cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '30b63388a2ad4cf19e9aa3888220a98f',
                content: '',
                id: '59ae10ae7fee437d828601fae86a955b',
                metadata: {
                    execution_start: 1759913029303,
                    execution_millis: 0,
                    execution_context_id: '6ba1d348-b911-4d71-a61c-ea2c18c6479a',
                    deepnote_big_number_title: 'test title',
                    deepnote_big_number_value: 'b',
                    deepnote_big_number_format: 'number',
                    deepnote_big_number_comparison_type: 'percentage-change',
                    deepnote_big_number_comparison_title: 'vs a',
                    deepnote_big_number_comparison_value: 'a',
                    deepnote_big_number_comparison_format: '',
                    deepnote_big_number_comparison_enabled: true
                },
                sortingKey: 'x',
                type: 'big-number',
                executionCount: 9,
                outputs: [
                    {
                        output_type: 'execute_result',
                        execution_count: 9,
                        data: {
                            'text/plain':
                                '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "percentage change", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, 'b');
        });

        test('converts absolute change comparison block to cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '8a409554b54241e89f4aa001506ce335',
                content: '',
                id: '8b3c525d4c974405a6d4da77b193023e',
                metadata: {
                    allow_embed: false,
                    execution_start: 1759939140215,
                    execution_millis: 1,
                    execution_context_id: 'f493c0ab-aea3-4cdd-84da-77865f369ba8',
                    deepnote_big_number_title: 'absolute change 2',
                    deepnote_big_number_value: 'b',
                    deepnote_big_number_format: 'number',
                    deepnote_big_number_comparison_type: 'absolute-change',
                    deepnote_big_number_comparison_title: 'vs a',
                    deepnote_big_number_comparison_value: 'a',
                    deepnote_big_number_comparison_format: '',
                    deepnote_big_number_comparison_enabled: true
                },
                sortingKey: 'y',
                type: 'big-number',
                executionCount: 9,
                outputs: [
                    {
                        output_type: 'execute_result',
                        execution_count: 9,
                        data: {
                            'text/plain':
                                '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "absolute change", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, 'b');
        });

        test('converts absolute value comparison block to cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '22df6f01c5c44cc081e3af4dceb397e7',
                content: '',
                id: 'f7016119e6554cfc8ab423ae4cc981b1',
                metadata: {
                    allow_embed: false,
                    execution_start: 1759939160631,
                    execution_millis: 0,
                    execution_context_id: 'f493c0ab-aea3-4cdd-84da-77865f369ba8',
                    deepnote_big_number_title: 'absolute change 2',
                    deepnote_big_number_value: 'b',
                    deepnote_big_number_format: 'number',
                    deepnote_big_number_comparison_type: 'absolute-value',
                    deepnote_big_number_comparison_title: 'vs a',
                    deepnote_big_number_comparison_value: 'a',
                    deepnote_big_number_comparison_format: '',
                    deepnote_big_number_comparison_enabled: true
                },
                sortingKey: 'yU',
                type: 'big-number',
                executionCount: 18,
                outputs: [
                    {
                        output_type: 'execute_result',
                        execution_count: 18,
                        data: {
                            'text/plain':
                                '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "absolute value", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, 'b');
        });

        test('converts disabled comparison block to cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '769a4e758a7b4e0b88d2e74bc82d75ca',
                content: '',
                id: '53cc14203e6243fe915b411a88b36845',
                metadata: {
                    allow_embed: false,
                    execution_start: 1759939184252,
                    execution_millis: 1,
                    execution_context_id: 'f493c0ab-aea3-4cdd-84da-77865f369ba8',
                    deepnote_big_number_title: 'some title',
                    deepnote_big_number_value: 'b',
                    deepnote_big_number_format: 'plain',
                    deepnote_big_number_comparison_type: 'percentage-change',
                    deepnote_big_number_comparison_title: 'vs a',
                    deepnote_big_number_comparison_value: 'a',
                    deepnote_big_number_comparison_format: '',
                    deepnote_big_number_comparison_enabled: false
                },
                sortingKey: 'yj',
                type: 'big-number',
                executionCount: 33,
                outputs: [
                    {
                        output_type: 'execute_result',
                        execution_count: 33,
                        data: {
                            'text/plain':
                                '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "Some title", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, 'b');
        });

        test('uses default value when metadata is invalid', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    invalid_field: 'invalid value'
                },
                sortingKey: 'a0',
                type: 'big-number'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '');
        });

        test('uses default value when metadata is empty', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {},
                sortingKey: 'a0',
                type: 'big-number'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies value expression to block metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {
                    existing: 'value',
                    deepnote_big_number_title: 'old title',
                    deepnote_big_number_value: 'old_value',
                    deepnote_big_number_format: 'currency'
                },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new_value', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_big_number_value, 'new_value');
            // Other metadata should be preserved
            assert.strictEqual(block.metadata?.existing, 'value');
            assert.strictEqual(block.metadata?.deepnote_big_number_title, 'old title');
            assert.strictEqual(block.metadata?.deepnote_big_number_format, 'currency');
        });

        test('removes DEEPNOTE_VSCODE_RAW_CONTENT_KEY when value is applied', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {
                    existing: 'value',
                    deepnote_big_number_value: 'old_value',
                    [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: 'old raw content'
                },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new_value', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_big_number_value, 'new_value');
            assert.strictEqual(block.metadata?.existing, 'value');
            assert.doesNotHaveAnyKeys(block.metadata, [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]);
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {
                    existing: 'value',
                    deepnote_big_number_value: 'old_value'
                },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_big_number_value, '');
            assert.strictEqual(block.metadata?.existing, 'value');
        });

        test('applies defaults when metadata is missing', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {},
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'my_value', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.deepStrictEqual(block.metadata, {
                deepnote_big_number_title: '',
                deepnote_big_number_value: 'my_value',
                deepnote_big_number_format: 'number',
                deepnote_big_number_comparison_type: '',
                deepnote_big_number_comparison_title: '',
                deepnote_big_number_comparison_value: '',
                deepnote_big_number_comparison_format: '',
                deepnote_big_number_comparison_enabled: false
            });
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                executionCount: 5,
                id: 'block-123',
                metadata: {
                    custom: 'value',
                    deepnote_big_number_title: 'title',
                    deepnote_big_number_value: 'old_value'
                },
                outputs: [],
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new_value', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.blockGroup, 'test-group');
            assert.strictEqual(block.content, '');
            assert.strictEqual(block.executionCount, 5);
            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.strictEqual(block.type, 'big-number');
            assert.deepStrictEqual(block.outputs, []);
            assert.strictEqual(block.metadata?.deepnote_big_number_value, 'new_value');
            assert.strictEqual(block.metadata?.custom, 'value');
        });
    });
});
