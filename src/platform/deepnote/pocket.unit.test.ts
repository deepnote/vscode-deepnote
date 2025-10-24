import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import { addPocketToCellMetadata, createBlockFromPocket, extractPocketFromCellMetadata } from './pocket';

suite('Pocket', () => {
    suite('addPocketToCellMetadata', () => {
        test('adds pocket with Deepnote-specific fields', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                id: 'block-123',
                type: 'code',
                sortingKey: 'a0',
                executionCount: 5,
                other: 'value'
            };

            addPocketToCellMetadata(cell);

            // id should remain at top level, not moved to pocket
            assert.deepStrictEqual(cell.metadata.__deepnotePocket, {
                type: 'code',
                sortingKey: 'a0',
                executionCount: 5
            });
            assert.strictEqual(cell.metadata.id, 'block-123');
            assert.strictEqual(cell.metadata.other, 'value');
        });

        test('does not add pocket if no Deepnote-specific fields exist', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                other: 'value'
            };

            addPocketToCellMetadata(cell);

            assert.isUndefined(cell.metadata.__deepnotePocket);
        });

        test('handles cell with no metadata', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            addPocketToCellMetadata(cell);

            assert.isUndefined(cell.metadata);
        });

        test('handles partial Deepnote fields', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                id: 'block-123',
                type: 'code'
            };

            addPocketToCellMetadata(cell);

            // id should remain at top level, not moved to pocket
            assert.deepStrictEqual(cell.metadata.__deepnotePocket, {
                type: 'code'
            });
            assert.strictEqual(cell.metadata.id, 'block-123');
        });
    });

    suite('extractPocketFromCellMetadata', () => {
        test('extracts pocket from cell metadata', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                __deepnotePocket: {
                    type: 'code',
                    sortingKey: 'a0',
                    executionCount: 5
                },
                id: 'block-123',
                other: 'value'
            };

            const pocket = extractPocketFromCellMetadata(cell);

            // id is not in the pocket anymore
            assert.deepStrictEqual(pocket, {
                type: 'code',
                sortingKey: 'a0',
                executionCount: 5
            });
        });

        test('returns undefined if no pocket exists', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                other: 'value'
            };

            const pocket = extractPocketFromCellMetadata(cell);

            assert.isUndefined(pocket);
        });

        test('returns undefined if cell has no metadata', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            const pocket = extractPocketFromCellMetadata(cell);

            assert.isUndefined(pocket);
        });
    });

    suite('createBlockFromPocket', () => {
        test('creates block from pocket metadata', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                __deepnotePocket: {
                    type: 'code',
                    sortingKey: 'a0',
                    executionCount: 5
                },
                id: 'block-123',
                custom: 'value'
            };

            const block = createBlockFromPocket(cell, 0);

            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'code');
            assert.strictEqual(block.sortingKey, 'a0');
            assert.strictEqual(block.executionCount, 5);
            assert.strictEqual(block.content, 'print("hello")');
            assert.strictEqual(block.outputs, undefined);
        });

        test('creates block with generated ID and sortingKey when no pocket exists', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            const block = createBlockFromPocket(cell, 5);

            assert.match(block.id, /^[0-9a-f]{32}$/);
            assert.strictEqual(block.type, 'code');
            assert.strictEqual(block.sortingKey, 'a5');
            assert.isUndefined(block.executionCount);
        });

        test('removes __deepnotePocket from block metadata', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                __deepnotePocket: {
                    type: 'code'
                },
                id: 'block-123',
                custom: 'value'
            };

            const block = createBlockFromPocket(cell, 0);

            assert.isUndefined(block.metadata?.__deepnotePocket);
            assert.isUndefined(block.metadata?.id);
            assert.strictEqual(block.metadata?.custom, 'value');
        });

        test('preserves other metadata fields', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                __deepnotePocket: {
                    type: 'code'
                },
                id: 'block-123',
                custom: 'value',
                slideshow: { slide_type: 'slide' }
            };

            const block = createBlockFromPocket(cell, 0);

            assert.strictEqual(block.metadata?.custom, 'value');
            assert.deepStrictEqual(block.metadata?.slideshow, { slide_type: 'slide' });
        });

        test('uses default type when no pocket exists', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            const block = createBlockFromPocket(cell, 0);

            assert.strictEqual(block.type, 'code');
        });

        test('handles partial pocket data', () => {
            const cell = new NotebookCellData(NotebookCellKind.Code, 'print("hello")', 'python');

            cell.metadata = {
                __deepnotePocket: {},
                id: 'block-123'
            };

            const block = createBlockFromPocket(cell, 3);

            assert.strictEqual(block.id, 'block-123');
            assert.strictEqual(block.type, 'code');
            assert.strictEqual(block.sortingKey, 'a3');
            assert.isUndefined(block.executionCount);
        });
    });
});
