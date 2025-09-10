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
            assert.strictEqual(cells[0].metadata?.deepnoteBlockId, 'block1');
            assert.strictEqual(cells[0].metadata?.deepnoteBlockType, 'code');
            assert.strictEqual(cells[0].metadata?.deepnoteSortingKey, 'a0');
            assert.deepStrictEqual(cells[0].metadata?.deepnoteMetadata, { custom: 'data' });
        });

        test('converts simple markdown block to cell', () => {
            const blocks: DeepnoteBlock[] = [
                {
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
            assert.strictEqual(cells[0].metadata?.deepnoteBlockId, 'block2');
            assert.strictEqual(cells[0].metadata?.deepnoteBlockType, 'markdown');
        });

        test('handles execution count and output reference', () => {
            const blocks: DeepnoteBlock[] = [
                {
                    id: 'block1',
                    type: 'code',
                    content: 'x = 1',
                    sortingKey: 'a0',
                    executionCount: 5,
                    outputReference: 'output-ref-123'
                }
            ];

            const cells = converter.convertBlocksToCells(blocks);

            assert.strictEqual(cells[0].metadata?.executionCount, 5);
            assert.strictEqual(cells[0].metadata?.deepnoteOutputReference, 'output-ref-123');
        });

        test('converts blocks with outputs', () => {
            const blocks: DeepnoteBlock[] = [
                {
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
                        deepnoteBlockId: 'existing-id',
                        deepnoteSortingKey: 'a5',
                        deepnoteMetadata: { original: 'metadata' }
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
                    languageId: 'markdown'
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

        test('handles execution count from metadata and executionSummary', () => {
            const cells: NotebookCellData[] = [
                {
                    kind: NotebookCellKind.Code,
                    value: 'x = 1',
                    languageId: 'python',
                    metadata: { executionCount: 10 }
                },
                {
                    kind: NotebookCellKind.Code,
                    value: 'y = 2',
                    languageId: 'python',
                    executionSummary: { executionOrder: 20 }
                }
            ];

            const blocks = converter.convertCellsToBlocks(cells);

            assert.strictEqual(blocks[0].executionCount, 10);
            assert.strictEqual(blocks[1].executionCount, 20);
        });

        test('includes output reference when present', () => {
            const cells: NotebookCellData[] = [
                {
                    kind: NotebookCellKind.Code,
                    value: 'print("test")',
                    languageId: 'python',
                    metadata: { deepnoteOutputReference: 'ref-123' }
                }
            ];

            const blocks = converter.convertCellsToBlocks(cells);

            assert.strictEqual(blocks[0].outputReference, 'ref-123');
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
    });

    suite('round trip conversion', () => {
        test('blocks -> cells -> blocks preserves data', () => {
            const originalBlocks: DeepnoteBlock[] = [
                {
                    id: 'block1',
                    type: 'code',
                    content: 'print("hello")',
                    sortingKey: 'a0',
                    executionCount: 5,
                    metadata: { custom: 'data' },
                    outputReference: 'ref-123',
                    outputs: [
                        {
                            output_type: 'stream',
                            text: 'hello\n'
                        }
                    ]
                },
                {
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

        test('blocks -> cells -> blocks preserves minimal multi-mime outputs', () => {
            const originalBlocks: DeepnoteBlock[] = [
                {
                    id: 'simple-multi',
                    type: 'code',
                    content: 'test',
                    sortingKey: 'z0',
                    outputs: [
                        {
                            output_type: 'execute_result',
                            execution_count: 1,
                            data: {
                                'text/plain': 'Result object',
                                'text/html': '<div>Result</div>'
                            }
                        }
                    ]
                }
            ];

            const cells = converter.convertBlocksToCells(originalBlocks);
            const roundTripBlocks = converter.convertCellsToBlocks(cells);

            assert.deepStrictEqual(roundTripBlocks, originalBlocks);
        });

        test('blocks -> cells -> blocks preserves simpler multi-mime outputs', () => {
            const originalBlocks: DeepnoteBlock[] = [
                {
                    id: 'multi-output-1',
                    type: 'code',
                    content: 'display(data)',
                    sortingKey: 'b0',
                    executionCount: 2,
                    outputs: [
                        // Stream with name
                        {
                            output_type: 'stream',
                            name: 'stdout',
                            text: 'Starting...\n'
                        },
                        // Execute result with multiple mimes
                        {
                            output_type: 'execute_result',
                            execution_count: 2,
                            data: {
                                'text/plain': 'Result object',
                                'text/html': '<div>Result</div>'
                            },
                            metadata: {
                                custom: 'value'
                            }
                        },
                        // Display data
                        {
                            output_type: 'display_data',
                            data: {
                                'text/plain': 'Display text',
                                'application/json': { result: true }
                            }
                        }
                    ]
                },
                {
                    id: 'error-block',
                    type: 'code',
                    content: 'error()',
                    sortingKey: 'b1',
                    executionCount: 3,
                    outputs: [
                        {
                            output_type: 'error',
                            ename: 'RuntimeError',
                            evalue: 'Something went wrong',
                            traceback: ['Line 1: error']
                        }
                    ]
                }
            ];

            const cells = converter.convertBlocksToCells(originalBlocks);
            const roundTripBlocks = converter.convertCellsToBlocks(cells);

            assert.deepStrictEqual(roundTripBlocks, originalBlocks);
        });

        test('blocks -> cells -> blocks preserves complex multi-mime rich outputs', () => {
            const originalBlocks: DeepnoteBlock[] = [
                {
                    id: 'rich-block-1',
                    type: 'code',
                    content: 'import matplotlib.pyplot as plt\nplt.plot([1,2,3])',
                    sortingKey: 'aa0',
                    executionCount: 3,
                    metadata: { slideshow: { slide_type: 'slide' } },
                    outputs: [
                        // Stream output
                        {
                            output_type: 'stream',
                            name: 'stdout',
                            text: 'Processing data...\n'
                        },
                        // Execute result with multiple mime types
                        {
                            output_type: 'execute_result',
                            execution_count: 3,
                            data: {
                                'text/plain': '<matplotlib.lines.Line2D at 0x7f8b8c0d5f50>',
                                'text/html': '<div class="plot">Plot rendered</div>',
                                'application/json': { type: 'plot', data: [1, 2, 3] }
                            },
                            metadata: {
                                needs_background: 'light'
                            }
                        },
                        // Display data with image
                        {
                            output_type: 'display_data',
                            data: {
                                'image/png':
                                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                                'text/plain': '<Figure size 640x480 with 1 Axes>'
                            },
                            metadata: {
                                image: {
                                    width: 640,
                                    height: 480
                                }
                            }
                        }
                    ]
                },
                {
                    id: 'rich-block-2',
                    type: 'code',
                    content: 'raise ValueError("Test error")',
                    sortingKey: 'aa1',
                    executionCount: 4,
                    outputs: [
                        // Error output with traceback
                        {
                            output_type: 'error',
                            ename: 'ValueError',
                            evalue: 'Test error',
                            traceback: [
                                '\u001b[0;31m---------------------------------------------------------------------------\u001b[0m',
                                '\u001b[0;31mValueError\u001b[0m                                Traceback (most recent call last)',
                                '\u001b[0;32m<ipython-input-4-5c5c51ed1a63>\u001b[0m in \u001b[0;36m<module>\u001b[0;34m\u001b[0m\n\u001b[0;32m----> 1\u001b[0;31m \u001b[0;32mraise\u001b[0m \u001b[0mValueError\u001b[0m\u001b[0;34m(\u001b[0m\u001b[0;34m"Test error"\u001b[0m\u001b[0;34m)\u001b[0m\u001b[0;34m\u001b[0m\u001b[0;34m\u001b[0m\u001b[0m\n\u001b[0m',
                                '\u001b[0;31mValueError\u001b[0m: Test error'
                            ]
                        }
                    ]
                },
                {
                    id: 'rich-block-3',
                    type: 'code',
                    content:
                        'from IPython.display import display, HTML, JSON\ndisplay(HTML("<b>Bold text</b>"), JSON({"key": "value"}))',
                    sortingKey: 'aa2',
                    executionCount: 5,
                    outputReference: 'output-ref-789',
                    outputs: [
                        // Multiple display_data outputs
                        {
                            output_type: 'display_data',
                            data: {
                                'text/html': '<b>Bold text</b>',
                                'text/plain': 'Bold text'
                            }
                        },
                        {
                            output_type: 'display_data',
                            data: {
                                'application/json': { key: 'value' },
                                'text/plain': "{'key': 'value'}"
                            },
                            metadata: {
                                expanded: false,
                                root: 'object'
                            }
                        }
                    ]
                },
                {
                    id: 'markdown-block',
                    type: 'markdown',
                    content: '## Results\n\nThe above cells demonstrate various output types.',
                    sortingKey: 'aa3',
                    metadata: { tags: ['documentation'] }
                }
            ];

            const cells = converter.convertBlocksToCells(originalBlocks);
            const roundTripBlocks = converter.convertCellsToBlocks(cells);

            assert.deepStrictEqual(roundTripBlocks, originalBlocks);
        });
    });
});
