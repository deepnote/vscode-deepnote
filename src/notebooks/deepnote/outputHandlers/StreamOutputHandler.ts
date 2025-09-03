import { NotebookCellOutput, NotebookCellOutputItem } from 'vscode';
import { decodeContent } from '../dataConversionUtils';
import type { DeepnoteOutput } from '../deepnoteTypes';

/**
 * Handles stream outputs (stdout/stderr) conversion between Deepnote and VS Code formats
 */
export class StreamOutputHandler {
    private readonly streamMimes = [
        'text/plain',
        'application/vnd.code.notebook.stdout',
        'application/vnd.code.notebook.stderr'
    ];

    /**
     * Convert VS Code stream output to Deepnote format
     */
    convertToDeepnote(output: NotebookCellOutput): DeepnoteOutput {
        const streamItems = output.items.filter((item) => this.streamMimes.includes(item.mime));

        // Combine all stream text
        const streamTexts = streamItems.map((item) => decodeContent(item.data));
        const text = streamTexts.join('');

        const deepnoteOutput: DeepnoteOutput = {
            output_type: 'stream',
            text
        };

        // Only set stream name if we can determine it from mime type
        const stderrItem = streamItems.find((item) => item.mime === 'application/vnd.code.notebook.stderr');
        if (stderrItem) {
            deepnoteOutput.name = 'stderr';
        }

        return deepnoteOutput;
    }

    /**
     * Convert Deepnote stream output to VS Code format
     */
    convertToVSCode(output: DeepnoteOutput): NotebookCellOutputItem[] {
        if (!output.text) {
            return [];
        }

        // Route to appropriate stream type based on Deepnote stream name
        if (output.name === 'stderr') {
            return [NotebookCellOutputItem.stderr(output.text)];
        } else {
            // Default to stdout for 'stdout' name or any other/missing stream name
            return [NotebookCellOutputItem.stdout(output.text)];
        }
    }
}
