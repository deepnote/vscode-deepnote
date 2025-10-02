import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
import { MarkdownBlockConverter } from './markdownBlockConverter';

suite('MarkdownBlockConverter', () => {
    let converter: MarkdownBlockConverter;

    setup(() => {
        converter = new MarkdownBlockConverter();
    });

    suite('canConvert', () => {
        test('returns true for markdown type', () => {
            assert.isTrue(converter.canConvert('markdown'));
        });

        test('canConvert ignores case', () => {
            assert.isTrue(converter.canConvert('MARKDOWN'));
            assert.isTrue(converter.canConvert('Markdown'));
            assert.isTrue(converter.canConvert('MaRkDoWn'));
        });

        test('returns false for non-markdown types', () => {
            assert.isFalse(converter.canConvert('code'));
            assert.isFalse(converter.canConvert('text-cell-h1'));
            assert.isFalse(converter.canConvert('unknown'));
        });
    });

    suite('getSupportedTypes', () => {
        test('returns array with markdown type', () => {
            const types = converter.getSupportedTypes();

            assert.deepStrictEqual(types, ['markdown']);
        });
    });

    suite('convertToCell', () => {
        test('converts markdown block to cell', () => {
            const block: DeepnoteBlock = {
                content: '# Title\n\nParagraph text',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '# Title\n\nParagraph text');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '');
        });

        test('handles missing content', () => {
            const block = {
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            } as DeepnoteBlock;

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '');
        });

        test('handles complex markdown', () => {
            const block: DeepnoteBlock = {
                content: '# Title\n\n## Subtitle\n\n- List item 1\n- List item 2\n\n```python\nprint("code")\n```',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(
                cell.value,
                '# Title\n\n## Subtitle\n\n- List item 1\n- List item 2\n\n```python\nprint("code")\n```'
            );
        });
    });

    suite('applyChangesToBlock', () => {
        test('applies cell content to block', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '# New Content', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '# New Content');
        });

        test('handles empty cell value', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                metadata: { custom: 'value' },
                sortingKey: 'a0',
                type: 'markdown'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, 'new content', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'new content');
            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'markdown');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.deepStrictEqual(block.metadata, { custom: 'value' });
        });

        test('handles complex markdown content', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'markdown'
            };
            const newContent = '# Title\n\n## Subtitle\n\n- Item 1\n- Item 2\n\n**Bold** and *italic*';
            const cell = new NotebookCellData(NotebookCellKind.Markup, newContent, 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, newContent);
        });
    });
});
