import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
import { CodeBlockConverter } from './codeBlockConverter';

suite('CodeBlockConverter', () => {
    let converter: CodeBlockConverter;

    setup(() => {
        converter = new CodeBlockConverter();
    });

    suite('canConvert', () => {
        test('returns true for code type', () => {
            assert.isTrue(converter.canConvert('code'));
        });

        test('returns false for non-code types', () => {
            assert.isFalse(converter.canConvert('markdown'));
            assert.isFalse(converter.canConvert('text-cell-h1'));
            assert.isFalse(converter.canConvert('unknown'));
        });
    });

    suite('getSupportedTypes', () => {
        test('returns array with code type', () => {
            const types = converter.getSupportedTypes();

            assert.deepStrictEqual(types, ['code']);
        });
    });

    suite('convertToCell', () => {
        test('converts code block to cell', () => {
            const block: DeepnoteBlock = {
                content: 'print("hello")',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'code'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, 'print("hello")');
            assert.strictEqual(cell.languageId, 'python');
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'code'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '');
        });

        test('handles missing content', () => {
            const block = {
                id: 'block-123',
                sortingKey: 'a0',
                type: 'code'
            } as DeepnoteBlock;

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '');
        });

        test('handles multi-line content', () => {
            const block: DeepnoteBlock = {
                content: 'import numpy as np\nimport pandas as pd\n\nprint("hello")',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'code'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, 'import numpy as np\nimport pandas as pd\n\nprint("hello")');
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies cell content to block', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'code'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new content', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'new content');
        });

        test('handles empty cell value', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'code'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                executionCount: 5,
                id: 'block-123',
                metadata: { custom: 'value' },
                outputs: [],
                sortingKey: 'a0',
                type: 'code'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'new content', 'python');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'new content');
            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'code');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.strictEqual(block.executionCount, 5);
            assert.deepStrictEqual(block.metadata, { custom: 'value' });
        });
    });
});
