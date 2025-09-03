import { NotebookCellData, NotebookCellKind, NotebookCellOutput, NotebookCellOutputItem } from 'vscode';

import type { DeepnoteBlock, DeepnoteOutput } from './deepnoteTypes';
import { OutputTypeDetector } from './OutputTypeDetector';
import { StreamOutputHandler } from './outputHandlers/StreamOutputHandler';
import { ErrorOutputHandler } from './outputHandlers/ErrorOutputHandler';
import { RichOutputHandler } from './outputHandlers/RichOutputHandler';
import { mergeMetadata, hasMetadataContent, generateBlockId, generateSortingKey } from './dataConversionUtils';

/**
 * Utility class for converting between Deepnote block structures and VS Code notebook cells.
 * Handles bidirectional conversion while preserving metadata and execution state.
 */
export class DeepnoteDataConverter {
    private readonly outputDetector = new OutputTypeDetector();
    private readonly streamHandler = new StreamOutputHandler();
    private readonly errorHandler = new ErrorOutputHandler();
    private readonly richHandler = new RichOutputHandler();

    /**
     * Converts Deepnote blocks to VS Code notebook cells.
     * Sorts blocks by sortingKey before conversion to maintain proper order.
     * @param blocks Array of Deepnote blocks to convert
     * @returns Array of VS Code notebook cell data
     */
    convertBlocksToCells(blocks: DeepnoteBlock[]): NotebookCellData[] {
        return blocks
            .sort((a, b) => a.sortingKey.localeCompare(b.sortingKey))
            .map((block) => this.convertBlockToCell(block));
    }

    /**
     * Converts VS Code notebook cells back to Deepnote blocks.
     * Generates missing IDs and sorting keys as needed.
     * @param cells Array of VS Code notebook cells to convert
     * @returns Array of Deepnote blocks
     */
    convertCellsToBlocks(cells: NotebookCellData[]): DeepnoteBlock[] {
        return cells.map((cell, index) => this.convertCellToBlock(cell, index));
    }

    private convertBlockToCell(block: DeepnoteBlock): NotebookCellData {
        const cellKind = block.type === 'code' ? NotebookCellKind.Code : NotebookCellKind.Markup;
        const languageId = block.type === 'code' ? 'python' : 'markdown';

        const cell = new NotebookCellData(cellKind, block.content, languageId);

        cell.metadata = {
            deepnoteBlockId: block.id,
            deepnoteBlockType: block.type,
            deepnoteSortingKey: block.sortingKey,
            deepnoteMetadata: block.metadata,
            ...(typeof block.executionCount === 'number' && { executionCount: block.executionCount }),
            ...(block.outputReference && { deepnoteOutputReference: block.outputReference })
        };

        cell.outputs = this.convertDeepnoteOutputsToVSCodeOutputs(block.outputs || []);

        return cell;
    }

    private convertCellToBlock(cell: NotebookCellData, index: number): DeepnoteBlock {
        const blockId = cell.metadata?.deepnoteBlockId || generateBlockId();
        const sortingKey = cell.metadata?.deepnoteSortingKey || generateSortingKey(index);
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
        return deepnoteOutputs.map((output) => this.convertSingleOutput(output));
    }

    private convertSingleOutput(output: DeepnoteOutput): NotebookCellOutput {
        const outputItems = this.createOutputItems(output);

        const metadata = mergeMetadata(
            output.metadata,
            output.execution_count !== undefined ? { executionCount: output.execution_count } : undefined
        );

        return hasMetadataContent(metadata)
            ? new NotebookCellOutput(outputItems, metadata)
            : new NotebookCellOutput(outputItems);
    }

    private convertVSCodeOutputsToDeepnoteOutputs(vscodeOutputs: NotebookCellOutput[]): DeepnoteOutput[] {
        return vscodeOutputs.map((output) => this.convertVSCodeSingleOutput(output));
    }

    private convertVSCodeSingleOutput(output: NotebookCellOutput): DeepnoteOutput {
        // Detect output type and delegate to appropriate handler
        const detection = this.outputDetector.detect(output);
        let deepnoteOutput: DeepnoteOutput;

        switch (detection.type) {
            case 'error':
                deepnoteOutput = this.errorHandler.convertToDeepnote(detection.errorItem!);
                break;
            case 'stream':
                deepnoteOutput = this.streamHandler.convertToDeepnote(output);
                break;
            case 'rich':
            default:
                deepnoteOutput = this.richHandler.convertToDeepnote(output);
                break;
        }

        // Preserve metadata from VS Code output
        if (output.metadata) {
            deepnoteOutput.metadata = mergeMetadata(deepnoteOutput.metadata, output.metadata);

            // Extract execution count from metadata
            if (output.metadata.executionCount !== undefined) {
                deepnoteOutput.execution_count = output.metadata.executionCount as number;
            }
        }

        return deepnoteOutput;
    }

    private createOutputItems(output: DeepnoteOutput): NotebookCellOutputItem[] {
        switch (output.output_type) {
            case 'stream':
                return this.streamHandler.convertToVSCode(output);
            case 'error':
                return this.errorHandler.convertToVSCode(output);
            case 'execute_result':
            case 'display_data':
                return this.richHandler.convertToVSCode(output);
            default:
                // Fallback for unknown types with text
                if (output.text) {
                    return [NotebookCellOutputItem.text(output.text)];
                }
                return [];
        }
    }
}
