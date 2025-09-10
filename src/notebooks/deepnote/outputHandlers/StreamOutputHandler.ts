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

        // Only set stream name if we can definitively determine it from mime type
        const stderrItem = streamItems.find((item) => item.mime === 'application/vnd.code.notebook.stderr');
        const stdoutItem = streamItems.find((item) => item.mime === 'application/vnd.code.notebook.stdout');
        const unnamedStreamItem = streamItems.find((item) => (item as NotebookCellOutputItem & { _wasUnnamedStream?: boolean })._wasUnnamedStream);

        if (stderrItem) {
            deepnoteOutput.name = 'stderr';
        } else if (stdoutItem && !unnamedStreamItem) {
            // Only set stdout name if it wasn't originally unnamed
            deepnoteOutput.name = 'stdout';
        }
        // Don't set name for streams that were originally unnamed

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
        } else if (output.name === 'stdout') {
            return [NotebookCellOutputItem.stdout(output.text)];
        } else {
            // For streams without explicit name, use stdout for proper VS Code display
            // but mark it as originally unnamed for round-trip preservation
            const item = NotebookCellOutputItem.stdout(output.text);
            (item as NotebookCellOutputItem & { _wasUnnamedStream?: boolean })._wasUnnamedStream = true;
            return [item];
        }
    }
}
