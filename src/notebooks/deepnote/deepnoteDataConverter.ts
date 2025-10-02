import { NotebookCellData, NotebookCellKind, NotebookCellOutput, NotebookCellOutputItem } from 'vscode';

import type { DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';
import { generateBlockId, generateSortingKey } from './dataConversionUtils';
import { ConverterRegistry } from './converters/converterRegistry';
import { CodeBlockConverter } from './converters/codeBlockConverter';
import { addPocketToCellMetadata, createBlockFromPocket } from './pocket';
import { TextBlockConverter } from './converters/textBlockConverter';
import { MarkdownBlockConverter } from './converters/markdownBlockConverter';

/**
 * Utility class for converting between Deepnote block structures and VS Code notebook cells.
 * Handles bidirectional conversion while preserving metadata and execution state.
 */
export class DeepnoteDataConverter {
    private readonly registry = new ConverterRegistry();

    constructor() {
        this.registry.register(new CodeBlockConverter());
        this.registry.register(new TextBlockConverter());
        this.registry.register(new MarkdownBlockConverter());
    }

    /**
     * Converts Deepnote blocks to VS Code notebook cells.
     * Sorts blocks by sortingKey before conversion to maintain proper order.
     * @param blocks Array of Deepnote blocks to convert
     * @returns Array of VS Code notebook cell data
     */
    convertBlocksToCells(blocks: DeepnoteBlock[]): NotebookCellData[] {
        return blocks.map((block) => {
            const converter = this.registry.findConverter(block.type);

            if (!converter) {
                // Fallback for unknown types - convert to markdown
                console.warn(`Unknown block type: ${block.type}, converting to markdown`);
                return this.createFallbackCell(block);
            }

            const cell = converter.convertToCell(block);

            const blockWithOptionalFields = block as DeepnoteBlock & { blockGroup?: string };

            cell.metadata = {
                ...block.metadata,
                id: block.id,
                type: block.type,
                sortingKey: block.sortingKey,
                ...(blockWithOptionalFields.blockGroup && { blockGroup: blockWithOptionalFields.blockGroup }),
                ...(block.executionCount !== undefined && { executionCount: block.executionCount }),
                ...(block.outputs !== undefined && { outputs: block.outputs })
            };

            // The pocket is a place to tuck away Deepnote-specific fields for later.
            addPocketToCellMetadata(cell);

            cell.outputs = this.transformOutputsForVsCode(block.outputs || []);

            return cell;
        });
    }

    /**
     * Converts VS Code notebook cells back to Deepnote blocks.
     * Generates missing IDs and sorting keys as needed.
     * @param cells Array of VS Code notebook cells to convert
     * @returns Array of Deepnote blocks
     */
    convertCellsToBlocks(cells: NotebookCellData[]): DeepnoteBlock[] {
        return cells.map((cell, index) => {
            const block = createBlockFromPocket(cell, index);

            const converter = this.registry.findConverter(block.type);

            if (!converter) {
                return this.createFallbackBlock(cell, index);
            }

            converter.applyChangesToBlock(block, cell);

            // If pocket didn't have outputs, but cell does, convert VS Code outputs to Deepnote format
            if (!block.outputs && cell.outputs && cell.outputs.length > 0) {
                block.outputs = this.transformOutputsForDeepnote(cell.outputs);
            }

            return block;
        });
    }

    private base64ToUint8Array(base64: string): Uint8Array {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);

        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return bytes;
    }

    private createFallbackBlock(cell: NotebookCellData, index: number): DeepnoteBlock {
        return {
            id: generateBlockId(),
            sortingKey: generateSortingKey(index),
            type: cell.kind === NotebookCellKind.Code ? 'code' : 'markdown',
            content: cell.value || ''
        };
    }

    private createFallbackCell(block: DeepnoteBlock): NotebookCellData {
        const cell = new NotebookCellData(NotebookCellKind.Markup, block.content || '', 'markdown');

        cell.metadata = {
            deepnoteBlockId: block.id,
            deepnoteBlockType: block.type,
            deepnoteSortingKey: block.sortingKey,
            deepnoteMetadata: block.metadata
        };

        return cell;
    }

    private transformOutputsForDeepnote(outputs: NotebookCellOutput[]): DeepnoteOutput[] {
        return outputs.map((output) => {
            // Check if this is an error output
            const errorItem = output.items.find((item) => item.mime === 'application/vnd.code.notebook.error');

            if (errorItem) {
                try {
                    const errorData = JSON.parse(new TextDecoder().decode(errorItem.data));

                    return {
                        ename: errorData.name || 'Error',
                        evalue: errorData.message || '',
                        output_type: 'error',
                        traceback: errorData.stack ? errorData.stack.split('\n') : []
                    } as DeepnoteOutput;
                } catch {
                    return {
                        ename: 'Error',
                        evalue: '',
                        output_type: 'error',
                        traceback: []
                    } as DeepnoteOutput;
                }
            }

            // Check if this is a stream output
            const stdoutItem = output.items.find((item) => item.mime === 'application/vnd.code.notebook.stdout');
            const stderrItem = output.items.find((item) => item.mime === 'application/vnd.code.notebook.stderr');

            if (stdoutItem || stderrItem) {
                const item = stdoutItem || stderrItem;
                const text = new TextDecoder().decode(item!.data);

                return {
                    name: stderrItem ? 'stderr' : 'stdout',
                    output_type: 'stream',
                    text
                } as DeepnoteOutput;
            }

            // Rich output (execute_result or display_data)
            const data: Record<string, unknown> = {};

            for (const item of output.items) {
                if (item.mime === 'text/plain') {
                    data['text/plain'] = new TextDecoder().decode(item.data);
                } else if (item.mime === 'text/html') {
                    data['text/html'] = new TextDecoder().decode(item.data);
                } else if (item.mime === 'application/json') {
                    data['application/json'] = JSON.parse(new TextDecoder().decode(item.data));
                } else if (item.mime === 'image/png') {
                    data['image/png'] = btoa(String.fromCharCode(...new Uint8Array(item.data)));
                } else if (item.mime === 'image/jpeg') {
                    data['image/jpeg'] = btoa(String.fromCharCode(...new Uint8Array(item.data)));
                } else if (item.mime === 'application/vnd.deepnote.dataframe.v3+json') {
                    data['application/vnd.deepnote.dataframe.v3+json'] = JSON.parse(
                        new TextDecoder().decode(item.data)
                    );
                }
            }

            const deepnoteOutput: DeepnoteOutput = {
                data,
                execution_count: (output.metadata?.executionCount as number) || 0,
                output_type: 'execute_result'
            };

            // Add metadata if present (excluding executionCount which we already handled)
            if (output.metadata) {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { executionCount, ...restMetadata } = output.metadata;

                if (Object.keys(restMetadata).length > 0) {
                    (deepnoteOutput as DeepnoteOutput & { metadata?: Record<string, unknown> }).metadata = restMetadata;
                }
            }

            return deepnoteOutput;
        });
    }

    private transformOutputsForVsCode(outputs: DeepnoteOutput[]): NotebookCellOutput[] {
        return outputs.map((output) => {
            if ('output_type' in output) {
                if (output.output_type === 'error') {
                    const errorOutput = output as { ename?: string; evalue?: string; traceback?: string[] };
                    const error = {
                        name: errorOutput.ename || 'Error',
                        message: errorOutput.evalue || '',
                        stack: errorOutput.traceback ? errorOutput.traceback.join('\n') : ''
                    };

                    return new NotebookCellOutput([NotebookCellOutputItem.error(error)]);
                }

                if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
                    const items: NotebookCellOutputItem[] = [];

                    // Handle text fallback if data is not present
                    if (!output.data && 'text' in output && output.text) {
                        items.push(NotebookCellOutputItem.text(String(output.text), 'text/plain'));
                    } else if (output.data && typeof output.data === 'object') {
                        const data = output.data as Record<string, unknown>;

                        // Order matters! Rich formats first, text/plain last
                        if (data['text/html']) {
                            items.push(
                                new NotebookCellOutputItem(
                                    new TextEncoder().encode(data['text/html'] as string),
                                    'text/html'
                                )
                            );
                        }

                        if (data['application/vnd.deepnote.dataframe.v3+json']) {
                            items.push(
                                NotebookCellOutputItem.json(
                                    data['application/vnd.deepnote.dataframe.v3+json'],
                                    'application/vnd.deepnote.dataframe.v3+json'
                                )
                            );
                        }

                        if (data['application/json']) {
                            items.push(NotebookCellOutputItem.json(data['application/json'], 'application/json'));
                        }

                        // Images (base64 encoded)
                        if (data['image/png']) {
                            items.push(
                                new NotebookCellOutputItem(
                                    this.base64ToUint8Array(data['image/png'] as string),
                                    'image/png'
                                )
                            );
                        }

                        if (data['image/jpeg']) {
                            items.push(
                                new NotebookCellOutputItem(
                                    this.base64ToUint8Array(data['image/jpeg'] as string),
                                    'image/jpeg'
                                )
                            );
                        }

                        // Plain text as fallback (always last)
                        if (data['text/plain']) {
                            items.push(NotebookCellOutputItem.text(data['text/plain'] as string));
                        }
                    }

                    // Preserve metadata and execution_count
                    const metadata: Record<string, unknown> = {};

                    if (output.execution_count !== undefined) {
                        metadata.executionCount = output.execution_count;
                    }

                    if ('metadata' in output && output.metadata) {
                        Object.assign(metadata, output.metadata);
                    }

                    return Object.keys(metadata).length > 0
                        ? new NotebookCellOutput(items, metadata)
                        : new NotebookCellOutput(items);
                }

                if (output.output_type === 'stream') {
                    if (!output.text) {
                        return new NotebookCellOutput([]);
                    }

                    const mimeType =
                        'name' in output && output.name === 'stderr'
                            ? 'application/vnd.code.notebook.stderr'
                            : 'application/vnd.code.notebook.stdout';

                    return new NotebookCellOutput([NotebookCellOutputItem.text(String(output.text), mimeType)]);
                }

                // Unknown output type - return as text if available
                if ('text' in output && output.text) {
                    return new NotebookCellOutput([NotebookCellOutputItem.text(String(output.text), 'text/plain')]);
                }

                // No text, return empty output
                return new NotebookCellOutput([]);
            }

            // Fallback for outputs without output_type but with text
            if ('text' in output && output.text) {
                return new NotebookCellOutput([NotebookCellOutputItem.text(String(output.text), 'text/plain')]);
            }

            return new NotebookCellOutput([]);
        });
    }
}
