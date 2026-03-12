import type { DeepnoteBlock } from '@deepnote/blocks';
import { assert } from 'chai';
import { NotebookCellData, NotebookCellKind } from 'vscode';
import { AgentBlockConverter } from './agentBlockConverter';
import dedent from 'dedent';

suite('AgentBlockConverter', () => {
    let converter: AgentBlockConverter;

    setup(() => {
        converter = new AgentBlockConverter();
    });

    suite('canConvert', () => {
        test('returns true for "agent" type', () => {
            assert.strictEqual(converter.canConvert('agent'), true);
        });

        test('returns true for "Agent" type (case insensitive)', () => {
            assert.strictEqual(converter.canConvert('Agent'), true);
        });

        test('returns false for other types', () => {
            assert.strictEqual(converter.canConvert('code'), false);
            assert.strictEqual(converter.canConvert('markdown'), false);
            assert.strictEqual(converter.canConvert('sql'), false);
        });
    });

    suite('getSupportedTypes', () => {
        test('returns array with "agent"', () => {
            const types = converter.getSupportedTypes();

            assert.deepStrictEqual(types, ['agent']);
        });
    });

    suite('convertToCell', () => {
        test('converts agent block to code cell with plaintext language', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'Analyze the dataset and create a summary report',
                id: 'agent-block-123',
                sortingKey: 'a0',
                metadata: { deepnote_agent_model: 'auto' },
                type: 'agent'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, 'Analyze the dataset and create a summary report');
            assert.strictEqual(cell.languageId, 'plaintext');
        });

        test('handles empty content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: '',
                id: 'agent-block-456',
                sortingKey: 'a1',
                metadata: { deepnote_agent_model: 'auto' },
                type: 'agent'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, '');
            assert.strictEqual(cell.languageId, 'plaintext');
        });

        test('handles undefined content', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                id: 'agent-block-789',
                sortingKey: 'a2',
                metadata: { deepnote_agent_model: 'auto' },
                type: 'agent'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, '');
            assert.strictEqual(cell.languageId, 'plaintext');
        });

        test('preserves multiline prompt', () => {
            const prompt = dedent`
                You are a senior data analyst.

                Perform a thorough exploratory analysis:
                1. Create a grouped bar chart of revenue by quarter
                2. Create a line chart showing churn rate trends
                3. Compute a pivot table of average revenue
            `;

            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: prompt,
                id: 'agent-block-multiline',
                sortingKey: 'a3',
                metadata: { deepnote_agent_model: 'auto' },
                type: 'agent'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, prompt);
            assert.strictEqual(cell.languageId, 'plaintext');
        });

        test('preserves agent block with metadata', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'Analyze the data',
                id: 'agent-block-with-metadata',
                metadata: {
                    deepnote_agent_model: 'gpt-4o'
                },
                sortingKey: 'a4',
                type: 'agent'
            };

            const cell = converter.convertToCell(block);

            assert.strictEqual(cell.kind, NotebookCellKind.Code);
            assert.strictEqual(cell.value, 'Analyze the data');
            assert.strictEqual(cell.languageId, 'plaintext');
        });
    });

    suite('applyChangesToBlock', () => {
        test('updates block content from cell value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'Old prompt',
                id: 'agent-block-123',
                sortingKey: 'a0',
                metadata: { deepnote_agent_model: 'auto' },
                type: 'agent'
            };
            const cell = new NotebookCellData(
                NotebookCellKind.Code,
                'New prompt with updated instructions',
                'plaintext'
            );

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New prompt with updated instructions');
        });

        test('handles empty cell value', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'Some prompt',
                id: 'agent-block-456',
                sortingKey: 'a1',
                metadata: { deepnote_agent_model: 'auto' },
                type: 'agent'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, '', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, '');
        });

        test('does not modify other block properties', () => {
            const block: DeepnoteBlock = {
                blockGroup: 'test-group',
                content: 'Old prompt',
                id: 'agent-block-789',
                metadata: {
                    deepnote_agent_model: 'gpt-4o',
                    custom: 'value'
                },
                sortingKey: 'a2',
                type: 'agent'
            };
            const cell = new NotebookCellData(NotebookCellKind.Code, 'New prompt', 'plaintext');

            converter.applyChangesToBlock(block, cell);

            assert.strictEqual(block.content, 'New prompt');
            assert.strictEqual(block.id, 'agent-block-789');
            assert.strictEqual(block.type, 'agent');
            assert.strictEqual(block.sortingKey, 'a2');
            assert.deepStrictEqual(block.metadata, {
                deepnote_agent_model: 'gpt-4o',
                custom: 'value'
            });
        });
    });
});
