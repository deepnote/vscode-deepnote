import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
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
                            'text/plain': '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "percentage change", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.deepnote_big_number_title, 'test title');
            assert.strictEqual(config.deepnote_big_number_value, 'b');
            assert.strictEqual(config.deepnote_big_number_format, 'number');
            assert.strictEqual(config.deepnote_big_number_comparison_type, 'percentage-change');
            assert.strictEqual(config.deepnote_big_number_comparison_title, 'vs a');
            assert.strictEqual(config.deepnote_big_number_comparison_value, 'a');
            assert.strictEqual(config.deepnote_big_number_comparison_format, '');
            assert.strictEqual(config.deepnote_big_number_comparison_enabled, true);
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
                            'text/plain': '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "absolute change", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.deepnote_big_number_title, 'absolute change 2');
            assert.strictEqual(config.deepnote_big_number_value, 'b');
            assert.strictEqual(config.deepnote_big_number_format, 'number');
            assert.strictEqual(config.deepnote_big_number_comparison_type, 'absolute-change');
            assert.strictEqual(config.deepnote_big_number_comparison_title, 'vs a');
            assert.strictEqual(config.deepnote_big_number_comparison_value, 'a');
            assert.strictEqual(config.deepnote_big_number_comparison_format, '');
            assert.strictEqual(config.deepnote_big_number_comparison_enabled, true);
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
                            'text/plain': '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "absolute value", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.deepnote_big_number_title, 'absolute change 2');
            assert.strictEqual(config.deepnote_big_number_value, 'b');
            assert.strictEqual(config.deepnote_big_number_format, 'number');
            assert.strictEqual(config.deepnote_big_number_comparison_type, 'absolute-value');
            assert.strictEqual(config.deepnote_big_number_comparison_title, 'vs a');
            assert.strictEqual(config.deepnote_big_number_comparison_value, 'a');
            assert.strictEqual(config.deepnote_big_number_comparison_format, '');
            assert.strictEqual(config.deepnote_big_number_comparison_enabled, true);
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
                            'text/plain': '{"comparisonTitle": "vs a", "comparisonValue": "10", "title": "sgjaoshdgoashgopiashgoihasdoighasoihgoiasdhgoisadhgoihsdoghasdoighaosdg", "value": "30"}'
                        },
                        metadata: {}
                    }
                ]
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.deepnote_big_number_title, 'some title');
            assert.strictEqual(config.deepnote_big_number_value, 'b');
            assert.strictEqual(config.deepnote_big_number_format, 'plain');
            assert.strictEqual(config.deepnote_big_number_comparison_type, 'percentage-change');
            assert.strictEqual(config.deepnote_big_number_comparison_title, 'vs a');
            assert.strictEqual(config.deepnote_big_number_comparison_value, 'a');
            assert.strictEqual(config.deepnote_big_number_comparison_format, '');
            assert.strictEqual(config.deepnote_big_number_comparison_enabled, false);
        });

        test('prefers raw content when DEEPNOTE_VSCODE_RAW_CONTENT_KEY exists', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_big_number_title: 'metadata title',
                    deepnote_big_number_value: 'metadata value',
                    [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: '{"deepnote_big_number_title": "raw title", "deepnote_big_number_value": "raw value"}'
                },
                sortingKey: 'a0',
                type: 'big-number'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');
            assert.strictEqual(cell.value, '{"deepnote_big_number_title": "raw title", "deepnote_big_number_value": "raw value"}');
        });

        test('uses default config when metadata is invalid', () => {
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
            assert.strictEqual(cell.languageId, 'json');

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.deepnote_big_number_title, null);
            assert.strictEqual(config.deepnote_big_number_value, null);
            assert.strictEqual(config.deepnote_big_number_format, null);
            assert.strictEqual(config.deepnote_big_number_comparison_type, null);
            assert.strictEqual(config.deepnote_big_number_comparison_title, null);
            assert.strictEqual(config.deepnote_big_number_comparison_value, null);
            assert.strictEqual(config.deepnote_big_number_comparison_format, null);
            assert.strictEqual(config.deepnote_big_number_comparison_enabled, null);
        });

        test('uses default config when metadata is empty', () => {
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
            assert.strictEqual(cell.languageId, 'json');

            const config = JSON.parse(cell.value);
            assert.strictEqual(config.deepnote_big_number_title, null);
            assert.strictEqual(config.deepnote_big_number_value, null);
            assert.strictEqual(config.deepnote_big_number_format, null);
            assert.strictEqual(config.deepnote_big_number_comparison_type, null);
            assert.strictEqual(config.deepnote_big_number_comparison_title, null);
            assert.strictEqual(config.deepnote_big_number_comparison_value, null);
            assert.strictEqual(config.deepnote_big_number_comparison_format, null);
            assert.strictEqual(config.deepnote_big_number_comparison_enabled, null);
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON config to block metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: { existing: 'value' },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const configStr = JSON.stringify({
                deepnote_big_number_title: 'new title',
                deepnote_big_number_value: 'new value',
                deepnote_big_number_format: 'number',
                deepnote_big_number_comparison_type: 'percentage-change',
                deepnote_big_number_comparison_title: 'vs old',
                deepnote_big_number_comparison_value: 'old value',
                deepnote_big_number_comparison_format: '',
                deepnote_big_number_comparison_enabled: true
            }, null, 2);
            const cell = new NotebookCellData(NotebookCellKind.Code, configStr, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_big_number_title, 'new title');
            assert.strictEqual(block.metadata?.deepnote_big_number_value, 'new value');
            assert.strictEqual(block.metadata?.deepnote_big_number_format, 'number');
            assert.strictEqual(block.metadata?.deepnote_big_number_comparison_type, 'percentage-change');
            assert.strictEqual(block.metadata?.deepnote_big_number_comparison_title, 'vs old');
            assert.strictEqual(block.metadata?.deepnote_big_number_comparison_value, 'old value');
            assert.strictEqual(block.metadata?.deepnote_big_number_comparison_format, '');
            assert.strictEqual(block.metadata?.deepnote_big_number_comparison_enabled, true);
            assert.strictEqual(block.metadata?.existing, 'value');
        });

        test('stores invalid JSON as raw content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: { existing: 'value' },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'invalid json {', 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], 'invalid json {');
            assert.strictEqual(block.metadata?.existing, 'value');
        });

        test('removes DEEPNOTE_VSCODE_RAW_CONTENT_KEY when valid config is applied', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {
                    existing: 'value',
                    [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: 'old raw content'
                },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const configStr = JSON.stringify({
                deepnote_big_number_title: 'new title'
            }, null, 2);
            const cell = new NotebookCellData(NotebookCellKind.Code, configStr, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_big_number_title, 'new title');
            assert.strictEqual(block.metadata?.existing, 'value');
            assert.isUndefined(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY]);
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: { existing: 'value' },
                sortingKey: 'a0',
                type: 'big-number'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], '');
            assert.strictEqual(block.metadata?.existing, 'value');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                executionCount: 5,
                id: 'block-123',
                metadata: { custom: 'value' },
                outputs: [],
                sortingKey: 'a0',
                type: 'big-number'
            };
            const configStr = JSON.stringify({
                deepnote_big_number_title: 'new title'
            }, null, 2);
            const cell = new NotebookCellData(NotebookCellKind.Code, configStr, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'big-number');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.strictEqual(block.executionCount, 5);
            assert.deepStrictEqual(block.outputs, []);
            assert.strictEqual(block.metadata?.custom, 'value');
        });
    });
});
