import { NotebookCellOutput, NotebookCellOutputItem } from 'vscode';
import { decodeContent } from '../dataConversionUtils';
import { MimeTypeProcessorRegistry } from '../MimeTypeProcessor';
import type { DeepnoteOutput } from '../deepnoteTypes';

/**
 * Handles rich/display data outputs conversion between Deepnote and VS Code formats
 */
export class RichOutputHandler {
    private readonly mimeRegistry = new MimeTypeProcessorRegistry();

    /**
     * Convert VS Code rich output to Deepnote format
     */
    convertToDeepnote(output: NotebookCellOutput): DeepnoteOutput {
        const deepnoteOutput: DeepnoteOutput = {
            output_type: 'display_data',
            data: {}
        };

        // Check for execution count in metadata
        if (output.metadata?.executionCount !== undefined) {
            deepnoteOutput.execution_count = output.metadata.executionCount;
            deepnoteOutput.output_type = 'execute_result';
        }

        for (const item of output.items) {
            // Skip only specific VS Code notebook stream and error mimes, but allow text/plain in rich context
            if (
                item.mime !== 'application/vnd.code.notebook.error' &&
                item.mime !== 'application/vnd.code.notebook.stdout' &&
                item.mime !== 'application/vnd.code.notebook.stderr'
            ) {
                try {
                    // Check if this item has preserved original base64 data
                    if ((item as any)._originalBase64 && item.mime.startsWith('image/')) {
                        deepnoteOutput.data![item.mime] = (item as any)._originalBase64;
                    } else {
                        const decodedContent = decodeContent(item.data);
                        deepnoteOutput.data![item.mime] = this.mimeRegistry.processForDeepnote(
                            decodedContent,
                            item.mime
                        );
                    }
                } catch (error) {
                    // Fallback: treat as text if any processing fails
                    try {
                        const decodedContent = decodeContent(item.data);
                        deepnoteOutput.data![item.mime] = decodedContent;
                    } catch {
                        // Skip this item if even text decoding fails
                        console.warn(`Failed to process output item with mime type: ${item.mime}`, error);
                    }
                }
            }
        }

        return deepnoteOutput;
    }

    /**
     * Convert Deepnote rich output to VS Code format
     */
    convertToVSCode(output: DeepnoteOutput): NotebookCellOutputItem[] {
        if (!output.data) {
            return output.text ? [NotebookCellOutputItem.text(output.text)] : [];
        }

        const items: NotebookCellOutputItem[] = [];

        for (const [mimeType, content] of Object.entries(output.data)) {
            const item = this.mimeRegistry.processForVSCode(content, mimeType);
            if (item) {
                items.push(item);
            }
        }

        return items;
    }
}
