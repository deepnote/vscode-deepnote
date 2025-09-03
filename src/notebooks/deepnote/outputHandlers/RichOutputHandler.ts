import { NotebookCellOutput, NotebookCellOutputItem } from 'vscode';
import { decodeContent } from '../dataConversionUtils';
import { MimeTypeProcessorRegistry } from '../MimeTypeProcessor';
import { OutputTypeDetector } from '../OutputTypeDetector';
import type { DeepnoteOutput } from '../deepnoteTypes';

/**
 * Handles rich/display data outputs conversion between Deepnote and VS Code formats
 */
export class RichOutputHandler {
    private readonly mimeRegistry = new MimeTypeProcessorRegistry();
    private readonly outputDetector = new OutputTypeDetector();

    /**
     * Convert VS Code rich output to Deepnote format
     */
    convertToDeepnote(output: NotebookCellOutput): DeepnoteOutput {
        const deepnoteOutput: DeepnoteOutput = {
            output_type: 'execute_result',
            data: {}
        };

        let hasDisplayData = false;

        for (const item of output.items) {
            // Skip stream and error mimes
            if (!this.outputDetector.isStreamMime(item.mime) && item.mime !== 'application/vnd.code.notebook.error') {
                try {
                    const decodedContent = decodeContent(item.data);
                    deepnoteOutput.data![item.mime] = this.mimeRegistry.processForDeepnote(decodedContent, item.mime);
                    hasDisplayData = true;
                } catch (error) {
                    // Fallback: treat as text if any processing fails
                    try {
                        const decodedContent = decodeContent(item.data);
                        deepnoteOutput.data![item.mime] = decodedContent;
                        hasDisplayData = true;
                    } catch {
                        // Skip this item if even text decoding fails
                        console.warn(`Failed to process output item with mime type: ${item.mime}`, error);
                    }
                }
            }
        }

        if (hasDisplayData) {
            // Use display_data for rich outputs without execution count, execute_result for those with
            deepnoteOutput.output_type = deepnoteOutput.execution_count ? 'execute_result' : 'display_data';
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
