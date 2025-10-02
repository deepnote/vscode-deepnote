import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
import { TextBlockConverter } from './textBlockConverter';

suite('TextBlockConverter', () => {
    let converter: TextBlockConverter;

    setup(() => {
        converter = new TextBlockConverter();
    });

    suite('canConvert', () => {
        test('returns true for text-cell types', () => {
            assert.isTrue(converter.canConvert('text-cell-h1'));
            assert.isTrue(converter.canConvert('text-cell-h2'));
            assert.isTrue(converter.canConvert('text-cell-h3'));
            assert.isTrue(converter.canConvert('text-cell-p'));
        });

        test('is case insensitive', () => {
            assert.isTrue(converter.canConvert('TEXT-CELL-H1'));
            assert.isTrue(converter.canConvert('Text-Cell-H2'));
        });

        test('returns false for non-text-cell types', () => {
            assert.isFalse(converter.canConvert('code'));
            assert.isFalse(converter.canConvert('markdown'));
            assert.isFalse(converter.canConvert('unknown'));
        });
    });

    suite('getSupportedTypes', () => {
        test('returns array of text-cell types', () => {
            const types = converter.getSupportedTypes();

            assert.deepStrictEqual(types, ['text-cell-h1', 'text-cell-h2', 'text-cell-h3', 'text-cell-p']);
        });
    });

    suite('convertToCell', () => {
        test('converts text-cell-h1 to cell with # prefix', () => {
            const block: DeepnoteBlock = {
                content: 'Main Title',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h1'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '# Main Title');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('converts text-cell-h2 to cell with ## prefix', () => {
            const block: DeepnoteBlock = {
                content: 'Section Title',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h2'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '## Section Title');
        });

        test('converts text-cell-h3 to cell with ### prefix', () => {
            const block: DeepnoteBlock = {
                content: 'Subsection Title',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h3'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '### Subsection Title');
        });

        test('converts text-cell-p to cell without prefix', () => {
            const block: DeepnoteBlock = {
                content: 'Paragraph text',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-p'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, 'Paragraph text');
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h1'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '# ');
        });

        test('handles missing content', () => {
            const block = {
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h2'
            } as DeepnoteBlock;

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '## ');
        });
    });

    suite('applyChangesToBlock', () => {
        test('strips # prefix from h1 cell', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '# New Title', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Title');
        });

        test('strips ## prefix from h2 cell', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h2'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '## New Section', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Section');
        });

        test('strips ### prefix from h3 cell', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h3'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '### New Subsection', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Subsection');
        });

        test('does not strip prefix from paragraph cell', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-p'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '# Not a heading', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '# Not a heading');
        });

        test('handles content without expected prefix', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, 'No prefix', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'No prefix');
        });

        test('handles empty cell value', () => {
            const block: DeepnoteBlock = {
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                type: 'text-cell-h1'
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
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '# New Title', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Title');
            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'text-cell-h1');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.deepStrictEqual(block.metadata, { custom: 'value' });
        });
    });
});
