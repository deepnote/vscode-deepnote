import { NotebookCellOutputItem } from 'vscode';
import { decodeContent, parseJsonSafely } from '../dataConversionUtils';
import type { DeepnoteOutput } from '../deepnoteTypes';

/**
 * Handles error outputs conversion between Deepnote and VS Code formats
 */
export class ErrorOutputHandler {
    /**
     * Convert VS Code error output to Deepnote format
     */
    convertToDeepnote(errorItem: { mime: string; data: Uint8Array }): DeepnoteOutput {
        const deepnoteOutput: DeepnoteOutput = {
            output_type: 'error'
        };

        try {
            const errorData = parseJsonSafely(decodeContent(errorItem.data));
            if (typeof errorData === 'object' && errorData !== null) {
                const errorObj = errorData as Record<string, unknown>;
                // Prefer Jupyter-style fields if they exist (for round-trip preservation)
                // Otherwise fallback to VS Code error structure
                deepnoteOutput.ename = (errorObj.ename as string) || (errorObj.name as string) || 'Error';
                deepnoteOutput.evalue = (errorObj.evalue as string) || (errorObj.message as string) || '';

                // Handle traceback - prefer original traceback array if it exists
                if (errorObj.traceback && Array.isArray(errorObj.traceback)) {
                    deepnoteOutput.traceback = errorObj.traceback as string[];
                } else if (errorObj.stack && typeof errorObj.stack === 'string') {
                    // Try extracting traceback from stack trace if custom properties weren't preserved
                    if (errorObj.stack.includes('__TRACEBACK_START__')) {
                        // Parse our special format
                        const tracebackMatch = errorObj.stack.match(/__TRACEBACK_START__\n(.*?)\n__TRACEBACK_END__/s);
                        if (tracebackMatch) {
                            deepnoteOutput.traceback = tracebackMatch[1].split('\n__TRACEBACK_LINE__\n');
                        } else {
                            deepnoteOutput.traceback = [];
                        }
                    } else {
                        const stackLines = errorObj.stack.split('\n');
                        // Skip the first line which is the error name/message
                        deepnoteOutput.traceback = stackLines.slice(1);
                    }
                } else {
                    deepnoteOutput.traceback = [];
                }
            } else {
                // Fallback if error data is not valid JSON object
                const errorText = String(errorData);
                deepnoteOutput.ename = 'Error';
                deepnoteOutput.evalue = errorText;
                deepnoteOutput.traceback = [errorText];
            }
        } catch {
            // Final fallback if parsing completely fails
            const errorText = decodeContent(errorItem.data);
            deepnoteOutput.ename = 'Error';
            deepnoteOutput.evalue = errorText;
            deepnoteOutput.traceback = [errorText];
        }

        return deepnoteOutput;
    }

    /**
     * Convert Deepnote error output to VS Code format
     */
    convertToVSCode(output: DeepnoteOutput): NotebookCellOutputItem[] {
        // Create a simple error with just the evalue as message
        const error = new Error(output.evalue || output.text || 'Error');

        // Store the original Deepnote error data for round-trip preservation
        if (output.ename) {
            error.name = output.ename;
            Object.assign(error, { ename: output.ename });
        }
        if (output.evalue) {
            Object.assign(error, { evalue: output.evalue });
        }
        if (output.traceback) {
            Object.assign(error, { traceback: output.traceback });
            // Also encode in the stack trace for better preservation
            // Join traceback with a special separator that we can split on later
            if (Array.isArray(output.traceback) && output.traceback.length > 0) {
                error.stack = `${output.ename || 'Error'}: ${
                    output.evalue || 'Unknown error'
                }\n__TRACEBACK_START__\n${output.traceback.join('\n__TRACEBACK_LINE__\n')}\n__TRACEBACK_END__`;
            }
        }
        if (output.error) {
            Object.assign(error, { deepnoteError: output.error });
        }

        return [NotebookCellOutputItem.error(error)];
    }
}
