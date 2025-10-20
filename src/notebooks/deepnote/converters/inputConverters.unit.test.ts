import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../../../platform/deepnote/deepnoteTypes';
import {
    InputTextBlockConverter,
    InputTextareaBlockConverter,
    InputSelectBlockConverter,
    InputSliderBlockConverter,
    InputCheckboxBlockConverter,
    InputDateBlockConverter,
    InputDateRangeBlockConverter,
    InputFileBlockConverter,
    ButtonBlockConverter
} from './inputConverters';
import { DEEPNOTE_VSCODE_RAW_CONTENT_KEY } from './constants';

suite('InputTextBlockConverter', () => {
    let converter: InputTextBlockConverter;

    setup(() => {
        converter = new InputTextBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-text block with metadata to JSON cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '92f21410c8c54ac0be7e4d2a544552ee',
                content: '',
                id: '70c6668216ce43cfb556e57247a31fb9',
                metadata: {
                    deepnote_input_label: 'some display name',
                    deepnote_variable_name: 'input_1',
                    deepnote_variable_value: 'some text input',
                    deepnote_variable_default_value: 'some default value'
                },
                sortingKey: 's',
                type: 'input-text'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_input_label, 'some display name');
            assert.strictEqual(parsed.deepnote_variable_name, 'input_1');
            assert.strictEqual(parsed.deepnote_variable_value, 'some text input');
            assert.strictEqual(parsed.deepnote_variable_default_value, 'some default value');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-text'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_input_label, '');
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.strictEqual(parsed.deepnote_variable_value, '');
            assert.isNull(parsed.deepnote_variable_default_value);
        });

        test('uses raw content when available', () => {
            const rawContent = '{"deepnote_variable_name": "custom"}';
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: rawContent
                },
                sortingKey: 'a0',
                type: 'input-text'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, rawContent);
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON to block metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-text'
            };
            const cellValue = JSON.stringify(
                {
                    deepnote_input_label: 'new label',
                    deepnote_variable_name: 'new_var',
                    deepnote_variable_value: 'new value',
                    deepnote_variable_default_value: 'new default'
                },
                null,
                2
            );
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_input_label, 'new label');
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'new_var');
            assert.strictEqual(block.metadata?.deepnote_variable_value, 'new value');
            assert.strictEqual(block.metadata?.deepnote_variable_default_value, 'new default');
        });

        test('handles invalid JSON by storing in raw content key', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-text'
            };
            const invalidJson = '{invalid json}';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });

        test('clears raw content key when valid JSON is applied', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: 'old raw content'
                },
                sortingKey: 'a0',
                type: 'input-text'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'var1'
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.isUndefined(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY]);
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                executionCount: 5,
                sortingKey: 'a0',
                type: 'input-text'
            };
            const cellValue = JSON.stringify({ deepnote_variable_name: 'var' });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'input-text');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.strictEqual(block.executionCount, 5);
        });
    });
});

suite('InputTextareaBlockConverter', () => {
    let converter: InputTextareaBlockConverter;

    setup(() => {
        converter = new InputTextareaBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-textarea block with multiline value to JSON cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '2b5f9340349f4baaa5a3237331214352',
                content: '',
                id: 'cbfee3d709dc4592b3186e8e95adca55',
                metadata: {
                    deepnote_variable_name: 'input_2',
                    deepnote_variable_value: 'some multiline\ntext input'
                },
                sortingKey: 'v',
                type: 'input-textarea'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, 'input_2');
            assert.strictEqual(parsed.deepnote_variable_value, 'some multiline\ntext input');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-textarea'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.strictEqual(parsed.deepnote_variable_value, '');
            assert.strictEqual(parsed.deepnote_input_label, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with multiline value to block metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-textarea'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'textarea_var',
                deepnote_variable_value: 'line1\nline2\nline3'
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'textarea_var');
            assert.strictEqual(block.metadata?.deepnote_variable_value, 'line1\nline2\nline3');
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-textarea'
            };
            const invalidJson = 'not json';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('InputSelectBlockConverter', () => {
    let converter: InputSelectBlockConverter;

    setup(() => {
        converter = new InputSelectBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-select block with single value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'ba248341bdd94b93a234777968bfedcf',
                content: '',
                id: '83cdcbd2ea5b462a900b6a3d7c8b04cf',
                metadata: {
                    deepnote_input_label: '',
                    deepnote_variable_name: 'input_3',
                    deepnote_variable_value: 'Option 1',
                    deepnote_variable_options: ['Option 1', 'Option 2'],
                    deepnote_variable_select_type: 'from-options',
                    deepnote_variable_custom_options: ['Option 1', 'Option 2'],
                    deepnote_variable_selected_variable: ''
                },
                sortingKey: 'x',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, 'input_3');
            assert.strictEqual(parsed.deepnote_variable_value, 'Option 1');
            assert.deepStrictEqual(parsed.deepnote_variable_options, ['Option 1', 'Option 2']);
        });

        test('converts input-select block with multiple values', () => {
            const block: DeepnoteBlock = {
                blockGroup: '9f77387639cd432bb913890dea32b6c3',
                content: '',
                id: '748548e64442416bb9f3a9c5ec22c4de',
                metadata: {
                    deepnote_input_label: 'some select display name',
                    deepnote_variable_name: 'input_4',
                    deepnote_variable_value: ['Option 1'],
                    deepnote_variable_options: ['Option 1', 'Option 2'],
                    deepnote_variable_select_type: 'from-options',
                    deepnote_allow_multiple_values: true,
                    deepnote_variable_custom_options: ['Option 1', 'Option 2'],
                    deepnote_variable_selected_variable: ''
                },
                sortingKey: 'y',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_allow_multiple_values, true);
            assert.deepStrictEqual(parsed.deepnote_variable_value, ['Option 1']);
        });

        test('converts input-select block with allow empty values', () => {
            const block: DeepnoteBlock = {
                blockGroup: '146c4af1efb2448fa2d3b7cfbd30da77',
                content: '',
                id: 'a3521dd942d2407693b0202b55c935a7',
                metadata: {
                    deepnote_input_label: 'allows empty value',
                    deepnote_variable_name: 'input_5',
                    deepnote_variable_value: 'Option 1',
                    deepnote_variable_options: ['Option 1', 'Option 2'],
                    deepnote_allow_empty_values: true,
                    deepnote_variable_select_type: 'from-options',
                    deepnote_variable_default_value: '',
                    deepnote_variable_custom_options: ['Option 1', 'Option 2'],
                    deepnote_variable_selected_variable: ''
                },
                sortingKey: 'yU',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_allow_empty_values, true);
            assert.strictEqual(parsed.deepnote_variable_default_value, '');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.strictEqual(parsed.deepnote_variable_value, 'Option 1');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with single value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-select'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'select_var',
                deepnote_variable_value: 'Option A',
                deepnote_variable_options: ['Option A', 'Option B']
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, 'Option A');
            assert.deepStrictEqual(block.metadata?.deepnote_variable_options, ['Option A', 'Option B']);
        });

        test('applies valid JSON with array value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-select'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_value: ['Option 1', 'Option 2'],
                deepnote_allow_multiple_values: true
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.deepStrictEqual(block.metadata?.deepnote_variable_value, ['Option 1', 'Option 2']);
            assert.strictEqual(block.metadata?.deepnote_allow_multiple_values, true);
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-select'
            };
            const invalidJson = '{broken';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('InputSliderBlockConverter', () => {
    let converter: InputSliderBlockConverter;

    setup(() => {
        converter = new InputSliderBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-slider block with basic configuration', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'e867ead6336e406992c632f315d8316b',
                content: '',
                id: 'ca9fb5f83cfc454e963d60aeb8060502',
                metadata: {
                    deepnote_input_label: 'slider input value',
                    deepnote_slider_step: 1,
                    deepnote_variable_name: 'input_6',
                    deepnote_variable_value: '5',
                    deepnote_slider_max_value: 10,
                    deepnote_slider_min_value: 0,
                    deepnote_variable_default_value: '5'
                },
                sortingKey: 'yj',
                type: 'input-slider'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, 'input_6');
            assert.strictEqual(parsed.deepnote_variable_value, '5');
            assert.strictEqual(parsed.deepnote_slider_min_value, 0);
            assert.strictEqual(parsed.deepnote_slider_max_value, 10);
            assert.strictEqual(parsed.deepnote_slider_step, 1);
        });

        test('converts input-slider block with custom step size', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'a28007ff7c7f4a9d831e7b92fe8f038c',
                content: '',
                id: '6b4ad1dc5dcd417cbecf5b0bcef7d5be',
                metadata: {
                    deepnote_input_label: 'step size 2',
                    deepnote_slider_step: 2,
                    deepnote_variable_name: 'input_7',
                    deepnote_variable_value: '6',
                    deepnote_slider_max_value: 10,
                    deepnote_slider_min_value: 4
                },
                sortingKey: 'yr',
                type: 'input-slider'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_slider_step, 2);
            assert.strictEqual(parsed.deepnote_slider_min_value, 4);
            assert.strictEqual(parsed.deepnote_variable_value, '6');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-slider'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.strictEqual(parsed.deepnote_slider_min_value, 0);
            assert.strictEqual(parsed.deepnote_slider_max_value, 10);
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with slider configuration', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-slider'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'slider1',
                deepnote_variable_value: '7',
                deepnote_slider_min_value: 0,
                deepnote_slider_max_value: 100,
                deepnote_slider_step: 5
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, '7');
            assert.strictEqual(block.metadata?.deepnote_slider_min_value, 0);
            assert.strictEqual(block.metadata?.deepnote_slider_max_value, 100);
            assert.strictEqual(block.metadata?.deepnote_slider_step, 5);
        });

        test('handles numeric value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-slider'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_value: 42
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            // Numeric values fail string schema validation, so stored in raw content
            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], cellValue);
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-slider'
            };
            const invalidJson = 'invalid';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('InputCheckboxBlockConverter', () => {
    let converter: InputCheckboxBlockConverter;

    setup(() => {
        converter = new InputCheckboxBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-checkbox block to JSON cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '5dd57f6bb90b49ebb954f6247b26427d',
                content: '',
                id: '9f97163d58f14192985d47f89f695239',
                metadata: {
                    deepnote_input_label: '',
                    deepnote_variable_name: 'input_8',
                    deepnote_variable_value: false
                },
                sortingKey: 'yv',
                type: 'input-checkbox'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, 'input_8');
            assert.strictEqual(parsed.deepnote_variable_value, false);
        });

        test('handles checkbox with true value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'check1',
                    deepnote_variable_value: true
                },
                sortingKey: 'a0',
                type: 'input-checkbox'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_value, true);
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-checkbox'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.strictEqual(parsed.deepnote_variable_value, false);
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with boolean value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-checkbox'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'checkbox1',
                deepnote_variable_value: true
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, true);
        });

        test('applies false value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-checkbox'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_value: false,
                deepnote_variable_default_value: true
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, false);
            assert.strictEqual(block.metadata?.deepnote_variable_default_value, true);
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-checkbox'
            };
            const invalidJson = '{]';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('InputDateBlockConverter', () => {
    let converter: InputDateBlockConverter;

    setup(() => {
        converter = new InputDateBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-date block to JSON cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'e84010446b844a86a1f6bbe5d89dc798',
                content: '',
                id: '33bce14fafc1431d9293dacc62e6e504',
                metadata: {
                    deepnote_input_label: '',
                    deepnote_variable_name: 'input_9',
                    deepnote_variable_value: '2025-10-13T00:00:00.000Z',
                    deepnote_input_date_version: 2
                },
                sortingKey: 'yx',
                type: 'input-date'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, 'input_9');
            assert.strictEqual(parsed.deepnote_variable_value, '2025-10-13T00:00:00.000Z');
            assert.strictEqual(parsed.deepnote_input_date_version, 2);
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            // Default value should be an ISO date string
            assert.match(parsed.deepnote_variable_value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with date value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'date1',
                deepnote_variable_value: '2025-12-31T00:00:00.000Z',
                deepnote_input_date_version: 2
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, '2025-12-31T00:00:00.000Z');
            assert.strictEqual(block.metadata?.deepnote_input_date_version, 2);
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date'
            };
            const invalidJson = 'not valid';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('InputDateRangeBlockConverter', () => {
    let converter: InputDateRangeBlockConverter;

    setup(() => {
        converter = new InputDateRangeBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-date-range block with absolute dates', () => {
            const block: DeepnoteBlock = {
                blockGroup: '1fe36d4de4f04fefbe80cdd0d1a3ad3b',
                content: '',
                id: '953d7ad89bbf42b38ee8ca1899c3b732',
                metadata: {
                    deepnote_variable_name: 'input_10',
                    deepnote_variable_value: ['2025-10-06', '2025-10-16']
                },
                sortingKey: 'yy',
                type: 'input-date-range'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, 'input_10');
            assert.deepStrictEqual(parsed.deepnote_variable_value, ['2025-10-06', '2025-10-16']);
        });

        test('converts input-date-range block with relative date', () => {
            const block: DeepnoteBlock = {
                blockGroup: '10e193de0aec4f3c80946edf358777e5',
                content: '',
                id: '322182f9673d45fda1c1aa13f8b02371',
                metadata: {
                    deepnote_input_label: 'relative past 3 months',
                    deepnote_variable_name: 'input_11',
                    deepnote_variable_value: 'past3months'
                },
                sortingKey: 'yyU',
                type: 'input-date-range'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_input_label, 'relative past 3 months');
            assert.strictEqual(parsed.deepnote_variable_value, 'past3months');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date-range'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.strictEqual(parsed.deepnote_variable_value, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with date range array', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date-range'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'range1',
                deepnote_variable_value: ['2025-01-01', '2025-12-31']
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.deepStrictEqual(block.metadata?.deepnote_variable_value, ['2025-01-01', '2025-12-31']);
        });

        test('applies valid JSON with relative date string', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date-range'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_value: 'past7days'
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, 'past7days');
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-date-range'
            };
            const invalidJson = '{{bad}}';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('InputFileBlockConverter', () => {
    let converter: InputFileBlockConverter;

    setup(() => {
        converter = new InputFileBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-file block to JSON cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: '651f4f5db96b43d5a6a1a492935fa08d',
                content: '',
                id: 'c20aa90dacad40b7817f5e7d2823ce88',
                metadata: {
                    deepnote_input_label: 'csv file input',
                    deepnote_variable_name: 'input_12',
                    deepnote_variable_value: '',
                    deepnote_allowed_file_extensions: '.csv'
                },
                sortingKey: 'yyj',
                type: 'input-file'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_input_label, 'csv file input');
            assert.strictEqual(parsed.deepnote_variable_name, 'input_12');
            assert.strictEqual(parsed.deepnote_allowed_file_extensions, '.csv');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-file'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_variable_name, '');
            assert.isNull(parsed.deepnote_allowed_file_extensions);
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with file extension', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-file'
            };
            const cellValue = JSON.stringify({
                deepnote_variable_name: 'file1',
                deepnote_allowed_file_extensions: '.pdf,.docx'
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_allowed_file_extensions, '.pdf,.docx');
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-file'
            };
            const invalidJson = 'bad json';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});

suite('ButtonBlockConverter', () => {
    let converter: ButtonBlockConverter;

    setup(() => {
        converter = new ButtonBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts button block with set_variable behavior', () => {
            const block: DeepnoteBlock = {
                blockGroup: '22e563550e734e75b35252e4975c3110',
                content: '',
                id: 'd1af4f0aea6943d2941d4a168b4d03f7',
                metadata: {
                    deepnote_button_title: 'Run',
                    deepnote_variable_name: 'button_1',
                    deepnote_button_behavior: 'set_variable',
                    deepnote_button_color_scheme: 'blue'
                },
                sortingKey: 'yyr',
                type: 'button'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'json');

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_button_title, 'Run');
            assert.strictEqual(parsed.deepnote_button_behavior, 'set_variable');
            assert.strictEqual(parsed.deepnote_button_color_scheme, 'blue');
        });

        test('converts button block with run behavior', () => {
            const block: DeepnoteBlock = {
                blockGroup: '2a1e97120eb24494adff278264625a4f',
                content: '',
                id: '6caaf767dc154528bbe3bb29f3c80f4e',
                metadata: {
                    deepnote_button_title: 'Run notebook button',
                    deepnote_variable_name: 'button_1',
                    deepnote_button_behavior: 'run',
                    deepnote_button_color_scheme: 'blue'
                },
                sortingKey: 'yyv',
                type: 'button'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_button_title, 'Run notebook button');
            assert.strictEqual(parsed.deepnote_button_behavior, 'run');
        });

        test('handles missing metadata with default config', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'button'
            };

            const cell = converter.convertToCell(block);

            const parsed = JSON.parse(cell.value);
            assert.strictEqual(parsed.deepnote_button_title, 'Run');
            assert.strictEqual(parsed.deepnote_button_behavior, 'set_variable');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies valid JSON with button configuration', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'button'
            };
            const cellValue = JSON.stringify({
                deepnote_button_title: 'Click Me',
                deepnote_button_behavior: 'run',
                deepnote_button_color_scheme: 'red'
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_button_title, 'Click Me');
            assert.strictEqual(block.metadata?.deepnote_button_behavior, 'run');
            assert.strictEqual(block.metadata?.deepnote_button_color_scheme, 'red');
        });

        test('applies different color schemes', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'button'
            };
            const cellValue = JSON.stringify({
                deepnote_button_color_scheme: 'green'
            });
            const cell = new NotebookCellData(NotebookCellKind.Code, cellValue, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_button_color_scheme, 'green');
        });

        test('handles invalid JSON', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'button'
            };
            const invalidJson = '}{';
            const cell = new NotebookCellData(NotebookCellKind.Code, invalidJson, 'json');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], invalidJson);
        });
    });
});
