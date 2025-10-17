import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';

import type { DeepnoteBlock } from '../deepnoteTypes';
import { SqlBlockConverter } from './sqlBlockConverter';
import dedent from 'dedent';

suite('SqlBlockConverter', () => {
    let converter: SqlBlockConverter;

    setup(() => {
        converter = new SqlBlockConverter();
    });

    suite('canConvert', () => {
        test('returns true for "sql" type', () => {
            assert.strictEqual(converter.canConvert('sql'), true);
        });

        test('returns true for "SQL" type (case insensitive)', () => {
            assert.strictEqual(converter.canConvert('SQL'), true);
        });

        test('returns false for other types', () => {
            assert.strictEqual(converter.canConvert('code'), false);
            assert.strictEqual(converter.canConvert('markdown'), false);
            assert.strictEqual(converter.canConvert('text-cell-h1'), false);
        });
    });

    suite('getSupportedTypes', () => {
        test('returns array with "sql"', () => {
            const types = converter.getSupportedTypes();

            assert.deepStrictEqual(types, ['sql']);
        });
    });

    suite('convertToCell', () => {
        test('converts SQL block to code cell with sql language', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'SELECT * FROM users WHERE age > 18',
                id: 'sql-block-123',
                sortingKey: 'a0',
                type: 'sql'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, 'SELECT * FROM users WHERE age > 18');
            assert.strictEqual(cell.languageId, 'sql');
        });

        test('handles empty SQL content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'sql-block-456',
                sortingKey: 'a1',
                type: 'sql'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, '');
            assert.strictEqual(cell.languageId, 'sql');
        });

        test('handles undefined SQL content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'sql-block-789',
                sortingKey: 'a2',
                type: 'sql'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, '');
            assert.strictEqual(cell.languageId, 'sql');
        });

        test('preserves multi-line SQL queries', () => {
            const sqlQuery = dedent`
                SELECT
                    u.name,
                    u.email,
                    COUNT(o.id) as order_count
                FROM users u
                LEFT JOIN orders o ON u.id = o.user_id
                WHERE u.created_at > '2024-01-01'
                GROUP BY u.id, u.name, u.email
                ORDER BY order_count DESC
                LIMIT 10
            `;

            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: sqlQuery,
                id: 'sql-block-complex',
                sortingKey: 'a3',
                type: 'sql'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, sqlQuery);
            assert.strictEqual(cell.languageId, 'sql');
        });

        test('preserves SQL block with metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'SELECT * FROM products',
                id: 'sql-block-with-metadata',
                metadata: {
                    sql_integration_id: 'postgres-prod',
                    table_state_spec: '{"pageSize": 50}'
                },
                sortingKey: 'a4',
                type: 'sql'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, 'SELECT * FROM products');
            assert.strictEqual(cell.languageId, 'sql');
            // Metadata is handled by the data converter, not the block converter
        });
    });

    suite('applyChangesToBlock', () => {
        test('updates block content from cell value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'SELECT * FROM old_table',
                id: 'sql-block-123',
                sortingKey: 'a0',
                type: 'sql'
            };
            const cell = new NotebookCellData(
                NotebookCellKind.Code,
                'SELECT * FROM new_table WHERE active = true',
                'sql'
            );

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'SELECT * FROM new_table WHERE active = true');
        });

        test('handles empty cell value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'SELECT * FROM users',
                id: 'sql-block-456',
                sortingKey: 'a1',
                type: 'sql'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'sql');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'SELECT * FROM old_query',
                id: 'sql-block-789',
                metadata: {
                    sql_integration_id: 'postgres-prod',
                    custom: 'value'
                },
                sortingKey: 'a2',
                type: 'sql'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'SELECT * FROM new_query', 'sql');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'SELECT * FROM new_query');
            assert.strictEqual(block.id, 'sql-block-789');
            assert.strictEqual(block.type, 'sql');
            assert.strictEqual(block.sortingKey, 'a2');
            assert.deepStrictEqual(block.metadata, {
                sql_integration_id: 'postgres-prod',
                custom: 'value'
            });
        });
    });
});
