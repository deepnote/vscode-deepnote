import { NotebookCellOutputItem, l10n } from 'vscode';
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
                deepnoteOutput.ename = (errorObj.ename as string) || 'Error';
                deepnoteOutput.evalue = (errorObj.evalue as string) || '';
                deepnoteOutput.traceback = (errorObj.traceback as string[]) || [];
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
        const errorMessage = this.buildErrorMessage(output);
        const error = new Error(errorMessage);

        // Add structured data as error properties for debugging
        if (output.ename) {
            error.name = output.ename;
        }
        if (output.evalue) {
            Object.assign(error, { evalue: output.evalue });
        }
        if (output.traceback) {
            Object.assign(error, { traceback: output.traceback });
        }
        if (output.error) {
            Object.assign(error, { deepnoteError: output.error });
        }

        return [NotebookCellOutputItem.error(error)];
    }

    /**
     * Build comprehensive error message with structured data
     */
    private buildErrorMessage(output: DeepnoteOutput): string {
        const baseMessage = output.text || l10n.t('Error occurred during execution');

        // Collect structured error details
        const errorDetails: string[] = [];

        if (output.ename) {
            errorDetails.push(l10n.t('Error Name: {0}', output.ename));
        }

        if (output.evalue) {
            errorDetails.push(l10n.t('Error Value: {0}', output.evalue));
        }

        // Add any additional structured fields from metadata or direct properties
        if (output.error) {
            errorDetails.push(l10n.t('Error Details: {0}', JSON.stringify(output.error)));
        }

        if (output.name && output.name !== output.ename) {
            errorDetails.push(l10n.t('Error Type: {0}', output.name));
        }

        if (output.stack) {
            errorDetails.push(l10n.t('Stack Trace: {0}', output.stack));
        }

        // Include traceback if available
        if (output.traceback && Array.isArray(output.traceback) && output.traceback.length > 0) {
            errorDetails.push(l10n.t('Traceback:\n{0}', output.traceback.join('\n')));
        }

        // Combine base message with structured details
        return errorDetails.length > 0
            ? `${baseMessage}\n\n${l10n.t('Error Details:')}\n${errorDetails.join('\n')}`
            : baseMessage;
    }
}
