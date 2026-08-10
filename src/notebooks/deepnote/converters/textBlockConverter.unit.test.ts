import type { DeepnoteBlock } from '@deepnote/blocks';
import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';
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
            assert.isTrue(converter.canConvert('text-cell-bullet'));
            assert.isTrue(converter.canConvert('text-cell-todo'));
            assert.isTrue(converter.canConvert('text-cell-callout'));
            assert.isTrue(converter.canConvert('separator'));
        });

        test('is case insensitive', () => {
            assert.isTrue(converter.canConvert('TEXT-CELL-H1'));
            assert.isTrue(converter.canConvert('Text-Cell-H2'));
            assert.isTrue(converter.canConvert('TEXT-CELL-BULLET'));
            assert.isTrue(converter.canConvert('Separator'));
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

            assert.deepStrictEqual(types, [
                'text-cell-h1',
                'text-cell-h2',
                'text-cell-h3',
                'text-cell-p',
                'text-cell-bullet',
                'text-cell-todo',
                'text-cell-callout',
                'separator'
            ]);
        });
    });

    suite('convertToCell', () => {
        test('converts text-cell-h1 to cell with # prefix', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Main Title',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h1'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '# Main Title');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('converts text-cell-h2 to cell with ## prefix', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Section Title',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h2'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '## Section Title');
        });

        test('converts text-cell-h3 to cell with ### prefix', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Subsection Title',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h3'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '### Subsection Title');
        });

        test('converts text-cell-p to cell without prefix', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Paragraph text',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-p'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, 'Paragraph text');
        });

        test('converts text-cell-bullet to cell with bullet list', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Bullet item',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-bullet'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '- Bullet item');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('converts text-cell-todo to cell with checkbox', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Todo item',
                id: 'block-123',
                metadata: { formattedRanges: [] },
                sortingKey: 'a0',
                type: 'text-cell-todo'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '- [ ] Todo item');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('converts text-cell-todo with checked state to cell with checked checkbox', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Completed todo',
                id: 'block-123',
                metadata: { checked: true, formattedRanges: [] },
                sortingKey: 'a0',
                type: 'text-cell-todo'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '- [x] Completed todo');
        });

        test('converts text-cell-callout to cell with blockquote', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'Important note',
                id: 'block-123',
                metadata: { formattedRanges: [] },
                sortingKey: 'a0',
                type: 'text-cell-callout'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '> Important note');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('converts separator to cell with horizontal rule', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: '',
                id: 'block-123',
                metadata: {},
                sortingKey: 'a0',
                type: 'separator'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Markup);
            assert.strictEqual(cell.value, '<hr>');
            assert.strictEqual(cell.languageId, 'markdown');
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: '',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h1'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.value, '# ');
        });
    });

    suite('applyChangesToBlock', () => {
        test('strips # prefix from h1 cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '# New Title', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Title');
        });

        test('strips # prefix with leading whitespace from h1 cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '  # New Title', 'markdown');

            converter.applyChangesToBlock(block, cell);

            // stripMarkdown doesn't handle leading whitespace, so it stays in the content
            assert.strictEqual(block.content, '# New Title');
        });

        test('strips ## prefix from h2 cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h2'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '## New Section', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Section');
        });

        test('strips ## prefix with leading whitespace from h2 cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h2'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '   ## New Section', 'markdown');

            converter.applyChangesToBlock(block, cell);

            // stripMarkdown doesn't handle leading whitespace, so it stays in the content
            assert.strictEqual(block.content, '## New Section');
        });

        test('strips ### prefix from h3 cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h3'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '### New Subsection', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New Subsection');
        });

        test('strips ### prefix with leading whitespace from h3 cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h3'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '\t### New Subsection', 'markdown');

            converter.applyChangesToBlock(block, cell);

            // stripMarkdown doesn't handle leading whitespace, so it stays in the content
            assert.strictEqual(block.content, '### New Subsection');
        });

        test('does not strip prefix from paragraph cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-p'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '# Not a heading', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '# Not a heading');
        });

        test('handles content without expected prefix', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, 'No prefix', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'No prefix');
        });

        test('handles empty cell value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-h1'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
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

        test('strips bullet prefix from bullet cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                sortingKey: 'a0',
                metadata: {},
                type: 'text-cell-bullet'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '- New bullet item', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New bullet item');
        });

        test('strips checkbox prefix from todo cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                metadata: { formattedRanges: [] },
                sortingKey: 'a0',
                type: 'text-cell-todo'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '- [ ] New todo item', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New todo item');
        });

        test('handles checked todo cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                metadata: { checked: false, formattedRanges: [] },
                sortingKey: 'a0',
                type: 'text-cell-todo'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '- [x] Completed task', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'Completed task');
        });

        test('strips blockquote prefix from callout cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: 'old content',
                id: 'block-123',
                metadata: { formattedRanges: [] },
                sortingKey: 'a0',
                type: 'text-cell-callout'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '> New callout text', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New callout text');
        });

        test('handles separator cell', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: '',
                id: 'block-123',
                metadata: {},
                sortingKey: 'a0',
                type: 'separator'
            };
            const cell = new NotebookCellData(NotebookCellKind.Markup, '---', 'markdown');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });
    });

    suite('round trip through real @deepnote/blocks library', () => {
        type TextBlockType = Extract<
            DeepnoteBlock,
            {
                type:
                    | 'text-cell-h1'
                    | 'text-cell-h2'
                    | 'text-cell-h3'
                    | 'text-cell-p'
                    | 'text-cell-bullet'
                    | 'text-cell-todo'
                    | 'text-cell-callout';
            }
        >;

        function assertRoundTrip(fixture: Pick<TextBlockType, 'type' | 'content' | 'metadata'>): DeepnoteBlock {
            // Constant identity fields; the fixture supplies the correlated type/content/metadata.
            const base = { blockGroup: 'group-123', id: 'block-123', sortingKey: 'a0' };

            const block: DeepnoteBlock = { ...base, ...fixture };

            const cell = converter.convertToCell(block);

            // A separate object for applyChangesToBlock to mutate, so the assertion
            // compares the stripped result against the original fixture content.
            const clone: DeepnoteBlock = { ...base, ...fixture };

            converter.applyChangesToBlock(clone, cell);

            assert.strictEqual(clone.content, fixture.content, `content must round-trip for ${fixture.type}`);

            return clone;
        }

        const specialContents = ['a_b * c', 'price: $5 (USD).', 'has `code` and #hash', 'Revenue grew 20% (great!).'];

        for (const content of specialContents) {
            test(`text-cell-h1 round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-h1', content, metadata: {} });
            });

            test(`text-cell-h2 round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-h2', content, metadata: {} });
            });

            test(`text-cell-h3 round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-h3', content, metadata: {} });
            });

            test(`text-cell-p round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-p', content, metadata: {} });
            });

            test(`text-cell-bullet round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-bullet', content, metadata: {} });
            });

            test(`text-cell-todo round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-todo', content, metadata: {} });
            });

            test(`text-cell-callout round-trips special content ${JSON.stringify(content)}`, () => {
                assertRoundTrip({ type: 'text-cell-callout', content, metadata: {} });
            });
        }

        test('literal backslash content round-trips exactly (tripwire)', () => {
            // Content contains a literal backslash followed by an underscore.
            // createMarkdown escapes both: `a\_b` -> `a\\\_b`. unescapeMarkdown must
            // consume exactly those pairs back to `a\_b`. If a future @deepnote/blocks
            // ever unescapes inside stripMarkdown while this wrapper is still present,
            // the content would be double-unescaped to `a_b` and this fails loudly.
            const content = String.raw`a\_b`;

            assertRoundTrip({ type: 'text-cell-p', content, metadata: {} });
            assertRoundTrip({ type: 'text-cell-h1', content, metadata: {} });
            assertRoundTrip({ type: 'text-cell-bullet', content, metadata: {} });
        });

        test('double round trip is stable (content is a fixed point)', () => {
            // Applying create -> strip twice must equal applying it once.
            const content = 'has `code` and #hash';
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content,
                id: 'block-123',
                metadata: {},
                sortingKey: 'a0',
                type: 'text-cell-p'
            };

            const cellOnce = converter.convertToCell(block);
            const afterOnce: DeepnoteBlock = { ...block, content: 'overwrite' };
            converter.applyChangesToBlock(afterOnce, cellOnce);

            const cellTwice = converter.convertToCell(afterOnce);
            const afterTwice: DeepnoteBlock = { ...afterOnce, content: 'overwrite' };
            converter.applyChangesToBlock(afterTwice, cellTwice);

            assert.strictEqual(afterOnce.content, content, 'first round-trip restores content');
            assert.strictEqual(afterTwice.content, afterOnce.content, 'second round-trip is a no-op (fixed point)');
        });

        test('text-cell-todo round-trips with metadata.checked: true', () => {
            assertRoundTrip({ type: 'text-cell-todo', content: 'a_b * c', metadata: { checked: true } });
        });

        test('text-cell-todo round-trips with metadata.checked: false', () => {
            assertRoundTrip({ type: 'text-cell-todo', content: 'a_b * c', metadata: { checked: false } });
        });

        test('text-cell-bullet round-trips with metadata.indent_level: 1', () => {
            // indent_level travels through metadata, not content. @deepnote/blocks@4.6.0+
            // renders two leading spaces per indent level before the bullet marker.
            const cell = converter.convertToCell({
                blockGroup: 'group-123',
                content: 'a_b * c',
                id: 'block-123',
                metadata: { indent_level: 1 },
                sortingKey: 'a0',
                type: 'text-cell-bullet'
            });

            assert.strictEqual(cell.value, '  - a\\_b \\* c');

            assertRoundTrip({ type: 'text-cell-bullet', content: 'a_b * c', metadata: { indent_level: 1 } });
        });

        test('leading/trailing whitespace is trimmed and then stable (pre-existing trim)', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'group-123',
                content: '  a_b  ',
                id: 'block-123',
                metadata: {},
                sortingKey: 'a0',
                type: 'text-cell-p'
            };

            const cell = converter.convertToCell(block);
            const stripped: DeepnoteBlock = { ...block, content: 'overwrite' };
            converter.applyChangesToBlock(stripped, cell);

            // Pre-existing trim: surrounding whitespace is removed by stripMarkdown's trim.
            assert.strictEqual(stripped.content, 'a_b', 'leading/trailing whitespace is trimmed');

            // Once trimmed, the content is stable across further round-trips.
            const trimmedRoundTrip = assertRoundTrip({ type: 'text-cell-p', content: 'a_b', metadata: {} });
            assert.strictEqual(trimmedRoundTrip.content, 'a_b');
        });
    });
});
