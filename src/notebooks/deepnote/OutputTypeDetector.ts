import { NotebookCellOutput } from 'vscode';

export type DetectedOutputType = 'error' | 'stream' | 'rich';

export interface OutputTypeResult {
    type: DetectedOutputType;
    streamMimes?: string[];
    errorItem?: { mime: string; data: Uint8Array };
}

/**
 * Detects the appropriate output type from VS Code NotebookCellOutput items
 */
export class OutputTypeDetector {
    private readonly streamMimes = [
        'text/plain',
        'application/vnd.code.notebook.stdout',
        'application/vnd.code.notebook.stderr'
    ];

    detect(output: NotebookCellOutput): OutputTypeResult {
        if (output.items.length === 0) {
            return { type: 'rich' };
        }

        // Check for error output first
        const errorItem = output.items.find((item) => item.mime === 'application/vnd.code.notebook.error');
        if (errorItem) {
            return {
                type: 'error',
                errorItem: { mime: errorItem.mime, data: errorItem.data }
            };
        }

        // Check for stream outputs
        const streamItems = output.items.filter((item) => this.streamMimes.includes(item.mime));
        if (streamItems.length > 0) {
            return {
                type: 'stream',
                streamMimes: streamItems.map((item) => item.mime)
            };
        }

        // Default to rich output
        return { type: 'rich' };
    }

    isStreamMime(mimeType: string): boolean {
        return this.streamMimes.includes(mimeType);
    }
}
