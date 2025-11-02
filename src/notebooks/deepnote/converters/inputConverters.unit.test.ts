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
        test('converts input-text block with metadata to plaintext cell with value', () => {
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
            assert.strictEqual(cell.languageId, 'plaintext');
            assert.strictEqual(cell.value, 'some text input');
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
            assert.strictEqual(cell.languageId, 'plaintext');
            assert.strictEqual(cell.value, '');
        });

        test('handles missing variable value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_input_label: 'some label'
                },
                sortingKey: 'a0',
                type: 'input-text'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'plaintext');
            assert.strictEqual(cell.value, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies text value from cell to block metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {
                    deepnote_input_label: 'existing label',
                    deepnote_variable_name: 'input_1',
                    deepnote_variable_value: 'old value'
                },
                sortingKey: 'a0',
                type: 'input-text'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new text value', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.deepStrictEqual(block.metadata, {
                deepnote_variable_value: 'new text value',
                // Other metadata should be preserved
                deepnote_input_label: 'existing label',
                deepnote_variable_name: 'input_1'
            });
        });

        test('handles empty value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'old content',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: 'old value'
                },
                sortingKey: 'a0',
                type: 'input-text'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, '');
        });

        test('preserves whitespace in value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-text'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '  text with spaces  \n', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, '  text with spaces  \n');
        });

        test('clears raw content key when variable name is applied', () => {
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
            const cell = new NotebookCellData(NotebookCellKind.Code, 'var1', 'plaintext');

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
            const cell = new NotebookCellData(NotebookCellKind.Code, 'var', 'plaintext');

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
        test('converts input-textarea block to plaintext cell with value', () => {
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
            assert.strictEqual(cell.languageId, 'plaintext');
            assert.strictEqual(cell.value, 'some multiline\ntext input');
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

            assert.strictEqual(cell.value, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies text value from cell to block metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'input_2'
                },
                sortingKey: 'a0',
                type: 'input-textarea'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new multiline\ntext value', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, 'new multiline\ntext value');
            // Variable name should be preserved
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'input_2');
        });

        test('handles empty value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'input-textarea'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, '');
        });
    });
});

suite('InputSelectBlockConverter', () => {
    let converter: InputSelectBlockConverter;

    setup(() => {
        converter = new InputSelectBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-select block to Python cell with quoted value', () => {
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
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '"Option 1"');
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

            assert.strictEqual(cell.value, 'None');
        });

        test('escapes quotes in single select value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: 'Option with "quotes"'
                },
                sortingKey: 'a0',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '"Option with \\"quotes\\""');
        });

        test('escapes backslashes in single select value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: 'Path\\to\\file'
                },
                sortingKey: 'a0',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '"Path\\\\to\\\\file"');
        });

        test('escapes quotes in multi-select array values', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: ['Option "A"', 'Option "B"']
                },
                sortingKey: 'a0',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '["Option \\"A\\"", "Option \\"B\\""]');
        });

        test('handles empty array for multi-select', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: []
                },
                sortingKey: 'a0',
                type: 'input-select'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '[]');
        });
    });

    suite('applyChangesToBlock', () => {
        test('preserves existing metadata (select blocks are readonly)', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'input_3',
                    deepnote_variable_options: ['Option A', 'Option B'],
                    deepnote_variable_value: 'Option A'
                },
                sortingKey: 'a0',
                type: 'input-select'
            };
            // Cell content is ignored since select blocks are readonly
            const cell = new NotebookCellData(NotebookCellKind.Code, '"Option B"', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            // Value should be preserved from metadata, not parsed from cell
            assert.strictEqual(block.metadata?.deepnote_variable_value, 'Option A');
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'input_3');
            assert.deepStrictEqual(block.metadata?.deepnote_variable_options, ['Option A', 'Option B']);
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
                    deepnote_variable_value: 5,
                    deepnote_slider_max_value: 10,
                    deepnote_slider_min_value: 0,
                    deepnote_variable_default_value: 5
                },
                sortingKey: 'yj',
                type: 'input-slider'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '5');
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
                    deepnote_variable_value: 6,
                    deepnote_slider_max_value: 10,
                    deepnote_slider_min_value: 4
                },
                sortingKey: 'yr',
                type: 'input-slider'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '6');
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

            assert.strictEqual(cell.value, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies numeric value from cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'slider1',
                    deepnote_slider_min_value: 0,
                    deepnote_slider_max_value: 100,
                    deepnote_slider_step: 5
                },
                sortingKey: 'a0',
                type: 'input-slider'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '7', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, '7');
            // Other metadata should be preserved
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'slider1');
            assert.strictEqual(block.metadata?.deepnote_slider_min_value, 0);
            assert.strictEqual(block.metadata?.deepnote_slider_max_value, 100);
            assert.strictEqual(block.metadata?.deepnote_slider_step, 5);
        });

        test('handles numeric value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'slider1'
                },
                sortingKey: 'a0',
                type: 'input-slider'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '42', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, '42');
        });

        test('handles invalid numeric value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'slider1',
                    deepnote_variable_value: '5'
                },
                sortingKey: 'a0',
                type: 'input-slider'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'invalid', 'python');

            converter.applyChangesToBlock(block, cell);

            // Should fall back to existing value (string per metadata contract)
            assert.strictEqual(block.metadata?.deepnote_variable_value, '5');
        });
    });
});

suite('InputCheckboxBlockConverter', () => {
    let converter: InputCheckboxBlockConverter;

    setup(() => {
        converter = new InputCheckboxBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-checkbox block to Python cell with boolean value', () => {
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
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, 'False');
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

            assert.strictEqual(cell.value, 'True');
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

            assert.strictEqual(cell.value, 'False');
        });
    });

    suite('applyChangesToBlock', () => {
        test('preserves existing metadata (checkbox blocks are readonly)', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'checkbox1',
                    deepnote_variable_value: false
                },
                sortingKey: 'a0',
                type: 'input-checkbox'
            };
            // Cell content is ignored since checkbox blocks are readonly
            const cell = new NotebookCellData(NotebookCellKind.Code, 'True', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            // Value should be preserved from metadata, not parsed from cell
            assert.strictEqual(block.metadata?.deepnote_variable_value, false);
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'checkbox1');
        });

        test('preserves default value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'checkbox1',
                    deepnote_variable_value: true,
                    deepnote_variable_default_value: true
                },
                sortingKey: 'a0',
                type: 'input-checkbox'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'False', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, true);
            assert.strictEqual(block.metadata?.deepnote_variable_default_value, true);
        });
    });
});

suite('InputDateBlockConverter', () => {
    let converter: InputDateBlockConverter;

    setup(() => {
        converter = new InputDateBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-date block to Python cell with quoted date', () => {
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
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '"2025-10-13T00:00:00.000Z"');
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

            assert.strictEqual(cell.value, '""');
        });
    });

    suite('applyChangesToBlock', () => {
        test('preserves existing metadata (date blocks are readonly)', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'date1',
                    deepnote_input_date_version: 2,
                    deepnote_variable_value: '2025-01-01T00:00:00.000Z'
                },
                sortingKey: 'a0',
                type: 'input-date'
            };
            // Cell content is ignored since date blocks are readonly
            const cell = new NotebookCellData(NotebookCellKind.Code, '"2025-12-31T00:00:00.000Z"', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            // Value should be preserved from metadata, not parsed from cell
            assert.strictEqual(block.metadata?.deepnote_variable_value, '2025-01-01T00:00:00.000Z');
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'date1');
            assert.strictEqual(block.metadata?.deepnote_input_date_version, 2);
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
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '("2025-10-06", "2025-10-16")');
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

            // Relative dates are not formatted as tuples
            assert.strictEqual(cell.value, '');
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

            assert.strictEqual(cell.value, '');
        });
    });

    suite('applyChangesToBlock', () => {
        test('preserves existing metadata (date range blocks are readonly)', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'range1',
                    deepnote_variable_value: ['2025-06-01', '2025-06-30']
                },
                sortingKey: 'a0',
                type: 'input-date-range'
            };
            // Cell content is ignored since date range blocks are readonly
            const cell = new NotebookCellData(NotebookCellKind.Code, '("2025-01-01", "2025-12-31")', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            // Value should be preserved from metadata, not parsed from cell
            assert.deepStrictEqual(block.metadata?.deepnote_variable_value, ['2025-06-01', '2025-06-30']);
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'range1');
        });
    });
});

suite('InputFileBlockConverter', () => {
    let converter: InputFileBlockConverter;

    setup(() => {
        converter = new InputFileBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts input-file block to Python cell with quoted file path', () => {
            const block: DeepnoteBlock = {
                blockGroup: '651f4f5db96b43d5a6a1a492935fa08d',
                content: '',
                id: 'c20aa90dacad40b7817f5e7d2823ce88',
                metadata: {
                    deepnote_input_label: 'csv file input',
                    deepnote_variable_name: 'input_12',
                    deepnote_variable_value: 'data.csv',
                    deepnote_allowed_file_extensions: '.csv'
                },
                sortingKey: 'yyj',
                type: 'input-file'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '"data.csv"');
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

            assert.strictEqual(cell.value, '');
        });

        test('escapes backslashes in Windows file paths', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: 'C:\\Users\\Documents\\file.txt'
                },
                sortingKey: 'a0',
                type: 'input-file'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '"C:\\\\Users\\\\Documents\\\\file.txt"');
        });

        test('escapes quotes in file paths', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_value: 'file "with quotes".txt'
                },
                sortingKey: 'a0',
                type: 'input-file'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '"file \\"with quotes\\".txt"');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies file path from cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'file1',
                    deepnote_allowed_file_extensions: '.pdf,.docx'
                },
                sortingKey: 'a0',
                type: 'input-file'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '"document.pdf"', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_variable_value, 'document.pdf');
            // Other metadata should be preserved
            assert.strictEqual(block.metadata?.deepnote_variable_name, 'file1');
            assert.strictEqual(block.metadata?.deepnote_allowed_file_extensions, '.pdf,.docx');
        });

        test('handles unquoted file path', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_variable_name: 'file1'
                },
                sortingKey: 'a0',
                type: 'input-file'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'file.txt', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.deepnote_variable_value, 'file.txt');
        });
    });
});

suite('ButtonBlockConverter', () => {
    let converter: ButtonBlockConverter;

    setup(() => {
        converter = new ButtonBlockConverter();
    });

    suite('convertToCell', () => {
        test('converts button block to Python cell with comment', () => {
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
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '# Buttons only work in Deepnote apps');
        });

        test('converts button block with run behavior to Python cell with comment', () => {
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

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '# Buttons only work in Deepnote apps');
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

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.languageId, 'python');
            assert.strictEqual(cell.value, '# Buttons only work in Deepnote apps');
        });
    });

    suite('applyChangesToBlock', () => {
        test('preserves existing metadata and ignores cell content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    deepnote_button_title: 'Click Me',
                    deepnote_button_behavior: 'run',
                    deepnote_button_color_scheme: 'red'
                },
                sortingKey: 'a0',
                type: 'button'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '# Buttons only work in Deepnote apps', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_button_title, 'Click Me');
            assert.strictEqual(block.metadata?.deepnote_button_behavior, 'run');
            assert.strictEqual(block.metadata?.deepnote_button_color_scheme, 'red');
        });

        test('applies default config when metadata is missing', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'button'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '# Buttons only work in Deepnote apps', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
            assert.strictEqual(block.metadata?.deepnote_button_title, 'Run');
            assert.strictEqual(block.metadata?.deepnote_button_behavior, 'set_variable');
            assert.strictEqual(block.metadata?.deepnote_button_color_scheme, 'blue');
        });

        test('removes raw content key from metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'block-123',
                metadata: {
                    [DEEPNOTE_VSCODE_RAW_CONTENT_KEY]: 'some raw content',
                    deepnote_button_title: 'Test'
                },
                sortingKey: 'a0',
                type: 'button'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '# Buttons only work in Deepnote apps', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.metadata?.[DEEPNOTE_VSCODE_RAW_CONTENT_KEY], undefined);
        });
    });
});
