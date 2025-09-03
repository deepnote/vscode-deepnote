import { type NotebookCellData, NotebookCellKind, NotebookCellOutput, NotebookCellOutputItem } from 'vscode';

import type { DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';

export class DeepnoteDataConverter {
    convertBlocksToCells(blocks: DeepnoteBlock[]): NotebookCellData[] {
        return blocks
            .sort((a, b) => a.sortingKey.localeCompare(b.sortingKey))
            .map(block => this.convertBlockToCell(block));
    }

    convertCellsToBlocks(cells: NotebookCellData[]): DeepnoteBlock[] {
        return cells.map((cell, index) => this.convertCellToBlock(cell, index));
    }

    private convertBlockToCell(block: DeepnoteBlock): NotebookCellData {
        const cellKind = block.type === 'code' ? NotebookCellKind.Code : NotebookCellKind.Markup;

        return {
            kind: cellKind,
            value: block.content,
            languageId: block.type === 'code' ? 'python' : 'markdown',
            metadata: {
                deepnoteBlockId: block.id,
                deepnoteBlockType: block.type,
                deepnoteSortingKey: block.sortingKey,
                deepnoteMetadata: block.metadata,
                ...(block.executionCount && { executionCount: block.executionCount }),
                ...(block.outputReference && { deepnoteOutputReference: block.outputReference })
            },
            outputs: this.convertDeepnoteOutputsToVSCodeOutputs(block.outputs || [])
        };
    }

    private convertCellToBlock(cell: NotebookCellData, index: number): DeepnoteBlock {
        const blockId = cell.metadata?.deepnoteBlockId || this.generateBlockId();
        const sortingKey = cell.metadata?.deepnoteSortingKey || this.generateSortingKey(index);
        const originalMetadata = cell.metadata?.deepnoteMetadata || {};

        const block: DeepnoteBlock = {
            id: blockId,
            sortingKey: sortingKey,
            type: cell.kind === NotebookCellKind.Code ? 'code' : 'markdown',
            content: cell.value,
            metadata: originalMetadata
        };

        if (cell.kind === NotebookCellKind.Code) {
            const executionCount = cell.metadata?.executionCount || cell.executionSummary?.executionOrder;
            if (executionCount !== undefined) {
                block.executionCount = executionCount;
            }
        }

        if (cell.metadata?.deepnoteOutputReference) {
            block.outputReference = cell.metadata.deepnoteOutputReference;
        }

        if (cell.outputs && cell.outputs.length > 0) {
            block.outputs = this.convertVSCodeOutputsToDeepnoteOutputs(cell.outputs);
        }

        return block;
    }

    private convertDeepnoteOutputsToVSCodeOutputs(deepnoteOutputs: DeepnoteOutput[]): NotebookCellOutput[] {
        return deepnoteOutputs.map(output => this.convertSingleOutput(output));
    }

    private convertSingleOutput(output: DeepnoteOutput): NotebookCellOutput {
        const outputItems = this.createOutputItems(output);

        return new NotebookCellOutput(outputItems, {
            ...(output.metadata && { metadata: output.metadata }),
            ...(output.execution_count && { executionCount: output.execution_count })
        });
    }

    private convertVSCodeOutputsToDeepnoteOutputs(vscodeOutputs: NotebookCellOutput[]): DeepnoteOutput[] {
        return vscodeOutputs.map(output => {
            const deepnoteOutput: DeepnoteOutput = {
                output_type: 'execute_result'
            };

            if (output.metadata?.executionCount) {
                deepnoteOutput.execution_count = output.metadata.executionCount as number;
            }

            if (output.items.length > 0) {
                const firstItem = output.items[0];

                if (firstItem.mime === 'text/plain') {
                    deepnoteOutput.output_type = 'stream';
                    deepnoteOutput.text = new TextDecoder().decode(firstItem.data);
                } else if (firstItem.mime === 'text/html') {
                    deepnoteOutput.output_type = 'execute_result';
                    deepnoteOutput.data = {
                        'text/html': new TextDecoder().decode(firstItem.data)
                    };
                } else if (firstItem.mime.startsWith('application/')) {
                    deepnoteOutput.output_type = 'execute_result';
                    deepnoteOutput.data = {
                        [firstItem.mime]: new TextDecoder().decode(firstItem.data)
                    };
                }

                if (output.items.length > 1) {
                    deepnoteOutput.data = {};
                    for (const item of output.items) {
                        deepnoteOutput.data[item.mime] = new TextDecoder().decode(item.data);
                    }
                }
            }

            return deepnoteOutput;
        });
    }

    private createErrorOutput(output: DeepnoteOutput): NotebookCellOutputItem[] {
        const errorText = output.text || 'Error occurred';
        return [NotebookCellOutputItem.error(new Error(errorText))];
    }

    private createOutputItems(output: DeepnoteOutput): NotebookCellOutputItem[] {
        if (output.output_type === 'stream') {
            return this.createStreamOutput(output);
        }

        if (output.output_type === 'error') {
            return this.createErrorOutput(output);
        }

        if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
            return this.createRichOutput(output);
        }

        // Fallback for unknown types with text
        if (output.text) {
            return [NotebookCellOutputItem.text(output.text)];
        }

        return [];
    }

    private createOutputItemForMimeType(mimeType: string, content: any): NotebookCellOutputItem | null {
        if (mimeType === 'text/plain') {
            return NotebookCellOutputItem.text(content as string);
        }

        if (mimeType === 'text/html') {
            return NotebookCellOutputItem.text(content as string, 'text/html');
        }

        if (mimeType.startsWith('application/')) {
            const jsonContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
            return NotebookCellOutputItem.text(jsonContent, mimeType);
        }

        return null;
    }

    private createRichOutput(output: DeepnoteOutput): NotebookCellOutputItem[] {
        if (!output.data) {
            return output.text ? [NotebookCellOutputItem.text(output.text)] : [];
        }

        const items: NotebookCellOutputItem[] = [];

        for (const [mimeType, content] of Object.entries(output.data)) {
            const item = this.createOutputItemForMimeType(mimeType, content);
            if (item) {
                items.push(item);
            }
        }

        return items;
    }

    private createStreamOutput(output: DeepnoteOutput): NotebookCellOutputItem[] {
        if (!output.text) {
            return [];
        }
        return [NotebookCellOutputItem.text(output.text)];
    }

    private generateBlockId(): string {
        const chars = '0123456789abcdef';
        let id = '';
        for (let i = 0; i < 32; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }

    private generateSortingKey(index: number): string {
        const alphabet = 'abcdefghijklmnopqrstuvwxyz';
        const letterIndex = Math.floor(index / 100);
        const letter = letterIndex < alphabet.length ? alphabet[letterIndex] : 'z';
        const number = index % 100;
        return `${letter}${number}`;
    }
}
