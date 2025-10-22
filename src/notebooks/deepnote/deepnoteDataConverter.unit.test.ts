import { assert } from 'chai';
import { NotebookCellKind, type NotebookCellData } from 'vscode';

import { DeepnoteDataConverter } from './deepnoteDataConverter';
import type { DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';

suite('DeepnoteDataConverter', () => {
    let converter: DeepnoteDataConverter;

    setup(() => {
        converter = new DeepnoteDataConverter();
    });

    suite('convertBlocksToCells', () => {
        test('converts simple code block to cell', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'print("hello")',
                    sortingKey: 'a0',
                    metadata: { custom: 'data' }
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);

            assert.strictEqual(cells.length, 1);
            assert.strictEqual(cells[0].kind, NotebookCellKind.Code);
            assert.strictEqual(cells[0].value, 'print("hello")');
            assert.strictEqual(cells[0].languageId, 'python');
            // id should be at top level, not in pocket
            assert.strictEqual(cells[0].metadata?.id, 'block1');
            assert.strictEqual(cells[0].metadata?.__deepnotePocket?.type, 'code');
            assert.strictEqual(cells[0].metadata?.__deepnotePocket?.sortingKey, 'a0');
            assert.strictEqual(cells[0].metadata?.custom, 'data');
        });

        test('converts simple markdown block to cell', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block2',
                    type: 'markdown',
                    content: '# Title',
                    sortingKey: 'a1'
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);

            assert.strictEqual(cells.length, 1);
            assert.strictEqual(cells[0].kind, NotebookCellKind.Markup);
            assert.strictEqual(cells[0].value, '# Title');
            assert.strictEqual(cells[0].languageId, 'markdown');
            // id should be at top level, not in pocket
            assert.strictEqual(cells[0].metadata?.id, 'block2');
            assert.strictEqual(cells[0].metadata?.__deepnotePocket?.type, 'markdown');
        });

        test('converts SQL block to cell with sql language', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block3',
                    type: 'sql',
                    content: 'SELECT * FROM users WHERE id = 1',
                    sortingKey: 'a2',
                    metadata: {
                        sql_integration_id: 'postgres-123'
                    }
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);

            assert.strictEqual(cells.length, 1);
            assert.strictEqual(cells[0].kind, NotebookCellKind.Code);
            assert.strictEqual(cells[0].value, 'SELECT * FROM users WHERE id = 1');
            assert.strictEqual(cells[0].languageId, 'sql');
            // id should be at top level, not in pocket
            assert.strictEqual(cells[0].metadata?.id, 'block3');
            assert.strictEqual(cells[0].metadata?.__deepnotePocket?.type, 'sql');
            assert.strictEqual(cells[0].metadata?.__deepnotePocket?.sortingKey, 'a2');
            assert.strictEqual(cells[0].metadata?.sql_integration_id, 'postgres-123');
        });

        test('handles execution count', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'x = 1',
                    sortingKey: 'a0',
                    executionCount: 5
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);

            assert.strictEqual(cells[0].metadata?.__deepnotePocket?.executionCount, 5);
        });

        test('converts blocks with outputs', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'print("hello")',
                    sortingKey: 'a0',
                    outputs: [
                        {
                            output_type: 'stream',
                            text: 'hello\n'
                        }
                    ]
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);

            assert.strictEqual(cells[0].outputs?.length, 1);
            assert.strictEqual(cells[0].outputs?.[0].items.length, 1);
            assert.strictEqual(cells[0].outputs?.[0].items[0].mime, 'application/vnd.code.notebook.stdout');
        });
    });

    suite('convertCellsToBlocks', () => {
        test('converts code cell to block', () => {
            const cells: NotebookCellData[] = [
                {
                    kind: NotebookCellKind.Code,
                    value: 'print("test")',
                    languageId: 'python',
                    metadata: {
                        __deepnotePocket: {
                            type: 'code',
                            sortingKey: 'a5'
                        },
                        id: 'existing-id',
                        original: 'metadata'
                    }
                }
            ];

            const blocks = converter.convertCellsToBlocks(cells);

            assert.strictEqual(blocks.length, 1);
            assert.strictEqual(blocks[0].type, 'code');
            assert.strictEqual(blocks[0].content, 'print("test")');
            assert.strictEqual(blocks[0].id, 'existing-id');
            assert.strictEqual(blocks[0].sortingKey, 'a5');
            assert.deepStrictEqual(blocks[0].metadata, { original: 'metadata' });
        });

        test('converts markdown cell to block', () => {
            const cells: NotebookCellData[] = [
                {
                    kind: NotebookCellKind.Markup,
                    value: '## Heading',
                    languageId: 'markdown',
                    metadata: {
                        __deepnotePocket: {
                            type: 'markdown'
                        }
                    }
                }
            ];

            const blocks = converter.convertCellsToBlocks(cells);

            assert.strictEqual(blocks[0].type, 'markdown');
            assert.strictEqual(blocks[0].content, '## Heading');
        });

        test('generates new IDs and sorting keys for cells without metadata', () => {
            const cells: NotebookCellData[] = [
                {
                    kind: NotebookCellKind.Code,
                    value: 'x = 1',
                    languageId: 'python'
                },
                {
                    kind: NotebookCellKind.Code,
                    value: 'y = 2',
                    languageId: 'python'
                }
            ];

            const blocks = converter.convertCellsToBlocks(cells);

            assert.strictEqual(blocks.length, 2);
            assert.match(blocks[0].id, /^[0-9a-f]{32}$/);
            assert.match(blocks[1].id, /^[0-9a-f]{32}$/);
            assert.notStrictEqual(blocks[0].id, blocks[1].id);
            assert.strictEqual(blocks[0].sortingKey, 'a0');
            assert.strictEqual(blocks[1].sortingKey, 'a1');
        });

        test('handles execution count from pocket', () => {
            const cells: NotebookCellData[] = [
                {
                    kind: NotebookCellKind.Code,
                    value: 'x = 1',
                    languageId: 'python',
                    metadata: {
                        __deepnotePocket: {
                            type: 'code',
                            executionCount: 10
                        }
                    }
                },
                {
                    kind: NotebookCellKind.Code,
                    value: 'y = 2',
                    languageId: 'python',
                    metadata: {
                        __deepnotePocket: {
                            type: 'code',
                            executionCount: 20
                        }
                    }
                }
            ];

            const blocks = converter.convertCellsToBlocks(cells);

            assert.strictEqual(blocks[0].executionCount, 10);
            assert.strictEqual(blocks[1].executionCount, 20);
        });
    });

    suite('output conversion', () => {
        test('converts stream output', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'stream',
                    text: 'Hello world\n'
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'print("Hello world")',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 1);
            assert.strictEqual(outputs[0].items[0].mime, 'application/vnd.code.notebook.stdout');
            assert.strictEqual(new TextDecoder().decode(outputs[0].items[0].data), 'Hello world\n');
        });

        test('converts error output', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'error',
                    text: "NameError: name 'x' is not defined"
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'print(x)',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 1);
            assert.strictEqual(outputs[0].items[0].mime, 'application/vnd.code.notebook.error');
        });

        test('converts execute_result with multiple mime types', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'execute_result',
                    execution_count: 1,
                    data: {
                        'text/plain': '42',
                        'text/html': '<div>42</div>',
                        'application/json': { value: 42 }
                    },
                    metadata: { custom: 'metadata' }
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'x',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 3);
            assert.strictEqual(outputs[0].metadata?.executionCount, 1);
            assert.strictEqual(outputs[0].metadata?.custom, 'metadata');

            const mimeTypes = outputs[0].items.map((item) => item.mime).sort();
            assert.deepStrictEqual(mimeTypes, ['application/json', 'text/html', 'text/plain']);
        });

        test('handles empty outputs', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'execute_result'
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'None',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 0);
        });

        test('handles unknown output types with text fallback', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'unknown_type',
                    text: 'fallback text'
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'something',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 1);
            assert.strictEqual(outputs[0].items[0].mime, 'text/plain');
            assert.strictEqual(new TextDecoder().decode(outputs[0].items[0].data), 'fallback text');
        });

        test('handles stream output without text', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'stream'
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'print()',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 0);
        });

        test('handles rich output without data but with text fallback', () => {
            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'execute_result',
                    text: 'fallback text'
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'result',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 1);
            assert.strictEqual(outputs[0].items[0].mime, 'text/plain');
            assert.strictEqual(new TextDecoder().decode(outputs[0].items[0].data), 'fallback text');
        });

        test('converts SQL metadata output', () => {
            const sqlMetadata = {
                status: 'read_from_cache_success',
                cache_created_at: '2024-10-21T10:30:00Z',
                compiled_query: 'SELECT * FROM users',
                variable_type: 'dataframe',
                integration_id: 'postgres-prod',
                size_in_bytes: 2621440
            };

            const deepnoteOutputs: DeepnoteOutput[] = [
                {
                    output_type: 'execute_result',
                    execution_count: 1,
                    data: {
                        'application/vnd.deepnote.sql-output-metadata+json': sqlMetadata
                    }
                }
            ];

            const blocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'SELECT * FROM users',
                    sortingKey: 'a0',
                    outputs: deepnoteOutputs
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);
            const outputs = cells[0].outputs!;

            assert.strictEqual(outputs.length, 1);
            assert.strictEqual(outputs[0].items.length, 1);
            assert.strictEqual(outputs[0].items[0].mime, 'application/vnd.deepnote.sql-output-metadata+json');

            const outputData = JSON.parse(new TextDecoder().decode(outputs[0].items[0].data));
            assert.deepStrictEqual(outputData, sqlMetadata);
        });
    });

    suite('round trip conversion', () => {
        test('blocks -> cells -> blocks preserves data', () => {
            const originalBlocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'block1',
                    type: 'code',
                    content: 'print("hello")',
                    sortingKey: 'a0',
                    executionCount: 5,
                    metadata: { custom: 'data' },
                    outputs: [
                        {
                            name: 'stdout',
                            output_type: 'stream',
                            text: 'hello\n'
                        }
                    ]
                },
                {
                    blockGroup: 'test-group',
                    id: 'block2',
                    type: 'markdown',
                    content: '# Title',
                    sortingKey: 'a1',
                    metadata: { another: 'value' }
                }
            ];

            const cells = converter.convertBlocksToCells(originalBlocks);
            const roundTripBlocks = converter.convertCellsToBlocks(cells);

            assert.deepStrictEqual(roundTripBlocks, originalBlocks);
        });

        test('SQL metadata output round-trips correctly', () => {
            const sqlMetadata = {
                status: 'read_from_cache_success',
                cache_created_at: '2024-10-21T10:30:00Z',
                compiled_query: 'SELECT * FROM users WHERE active = true',
                variable_type: 'dataframe',
                integration_id: 'postgres-prod',
                size_in_bytes: 2621440
            };

            const originalBlocks: DeepnoteBlock[] = [
                {
                    blockGroup: 'test-group',
                    id: 'sql-block',
                    type: 'code',
                    content: 'SELECT * FROM users WHERE active = true',
                    sortingKey: 'a0',
                    executionCount: 1,
                    metadata: {},
                    outputs: [
                        {
                            output_type: 'execute_result',
                            execution_count: 1,
                            data: {
                                'application/vnd.deepnote.sql-output-metadata+json': sqlMetadata
                            }
                        }
                    ]
                }
            ];

            const cells = converter.convertBlocksToCells(originalBlocks);
            const roundTripBlocks = converter.convertCellsToBlocks(cells);

            // The round-trip should preserve the SQL metadata output
            assert.strictEqual(roundTripBlocks.length, 1);
            assert.strictEqual(roundTripBlocks[0].id, 'sql-block');
            assert.strictEqual(roundTripBlocks[0].outputs?.length, 1);

            const output = roundTripBlocks[0].outputs![0] as {
                output_type: string;
                data?: Record<string, unknown>;
            };
            assert.strictEqual(output.output_type, 'execute_result');
            assert.deepStrictEqual(output.data?.['application/vnd.deepnote.sql-output-metadata+json'], sqlMetadata);
        });

        test('real deepnote notebook round-trips without losing data', () => {
            // Inline test data representing a real Deepnote notebook with various block types
            // blockGroup is an optional field not in the DeepnoteBlock interface, so we cast as any
            const originalBlocks = [
                {
                    blockGroup: '1a4224497bcd499ba180e5795990aaa8',
                    content: '# Data Exploration\n\nThis notebook demonstrates basic data exploration.',
                    id: 'b0524a309dff421e95f2efd64aaca02a',
                    metadata: {},
                    sortingKey: 'a0',
                    type: 'markdown'
                },
                {
                    blockGroup: '9dd9578e604a4235a552d1f4a53336ee',
                    content: 'import pandas as pd\nimport numpy as np\n\nnp.random.seed(42)',
                    executionCount: 1,
                    id: 'b75d3ada977549b29f4c7f2183d52fcf',
                    metadata: {
                        execution_start: 1759390294701,
                        execution_millis: 1
                    },
                    outputs: [],
                    sortingKey: 'm',
                    type: 'code'
                },
                {
                    blockGroup: 'cf243a3bbe914b7598eb86935c9f5cf4',
                    content: 'print("Dataset shape:", df.shape)',
                    executionCount: 3,
                    id: '6e8982f5cae54715b7620c9dc58e6de5',
                    metadata: {
                        execution_start: 1759390294821,
                        execution_millis: 3
                    },
                    outputs: [
                        {
                            name: 'stdout',
                            output_type: 'stream',
                            text: 'Dataset shape: (100, 5)\n'
                        }
                    ],
                    sortingKey: 'y',
                    type: 'code'
                },
                {
                    blockGroup: 'e3e8eea67aa64ed981c86edff029dc40',
                    content: 'print(r)',
                    executionCount: 7,
                    id: '8b99dc5b5ee94e0e9ec278466344ae2b',
                    metadata: {
                        execution_start: 1759390787589,
                        execution_millis: 320
                    },
                    outputs: [
                        {
                            ename: 'NameError',
                            evalue: "name 'r' is not defined",
                            output_type: 'error',
                            traceback: [
                                '\u001b[0;31m---------------------------------------------------------------------------\u001b[0m',
                                '\u001b[0;31mNameError\u001b[0m                                 Traceback (most recent call last)'
                            ]
                        }
                    ],
                    sortingKey: 'yj',
                    type: 'code'
                }
            ] as unknown as DeepnoteBlock[];

            // Convert blocks -> cells -> blocks
            const cells = converter.convertBlocksToCells(originalBlocks);
            const roundTripBlocks = converter.convertCellsToBlocks(cells);

            // Should preserve all blocks without data loss
            assert.deepStrictEqual(roundTripBlocks, originalBlocks);
        });
    });
});
