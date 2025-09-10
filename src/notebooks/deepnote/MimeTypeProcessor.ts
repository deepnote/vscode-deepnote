import { NotebookCellOutputItem } from 'vscode';
import { parseJsonSafely, convertBase64ToUint8Array } from './dataConversionUtils';

export interface MimeProcessor {
    canHandle(mimeType: string): boolean;
    processForDeepnote(content: unknown, mimeType: string): unknown;
    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null;
}

/**
 * Handles text-based MIME types
 */
export class TextMimeProcessor implements MimeProcessor {
    private readonly supportedTypes = ['text/plain', 'text/html'];

    canHandle(mimeType: string): boolean {
        return this.supportedTypes.includes(mimeType);
    }

    processForDeepnote(content: unknown): unknown {
        return typeof content === 'string' ? content : String(content);
    }

    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null {
        if (mimeType === 'text/plain') {
            return NotebookCellOutputItem.text(content as string, 'text/plain');
        }
        if (mimeType === 'text/html') {
            return NotebookCellOutputItem.text(content as string, 'text/html');
        }
        return null;
    }
}

/**
 * Handles image MIME types
 */
export class ImageMimeProcessor implements MimeProcessor {
    canHandle(mimeType: string): boolean {
        return mimeType.startsWith('image/');
    }

    processForDeepnote(content: unknown, _mimeType: string): unknown {
        if (content instanceof Uint8Array) {
            const base64String = btoa(String.fromCharCode(...content));
            return base64String;
        }
        // If it's already a string (base64 or data URL), return as-is
        return content;
    }

    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null {
        try {
            let uint8Array: Uint8Array;

            if (typeof content === 'string') {
                uint8Array = convertBase64ToUint8Array(content);
                // Store the original base64 string for round-trip preservation
                const item = new NotebookCellOutputItem(uint8Array, mimeType);
                // Use a property that won't interfere with VS Code but preserves the original data
                (item as any)._originalBase64 = content;
                return item;
            } else if (content instanceof ArrayBuffer) {
                uint8Array = new Uint8Array(content);
            } else if (content instanceof Uint8Array) {
                uint8Array = content;
            } else {
                return null;
            }

            return new NotebookCellOutputItem(uint8Array, mimeType);
        } catch {
            return NotebookCellOutputItem.text(String(content), mimeType);
        }
    }
}

/**
 * Handles JSON MIME types
 */
export class JsonMimeProcessor implements MimeProcessor {
    canHandle(mimeType: string): boolean {
        return mimeType === 'application/json';
    }

    processForDeepnote(content: unknown): unknown {
        if (typeof content === 'string') {
            return parseJsonSafely(content);
        }
        return content;
    }

    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null {
        try {
            let jsonObject: unknown;

            if (typeof content === 'string') {
                jsonObject = JSON.parse(content);
            } else if (typeof content === 'object' && content !== null) {
                jsonObject = content;
            } else {
                return NotebookCellOutputItem.text(String(content), mimeType);
            }

            return NotebookCellOutputItem.text(JSON.stringify(jsonObject, null, 2), mimeType);
        } catch {
            return NotebookCellOutputItem.text(String(content), mimeType);
        }
    }
}

/**
 * Handles other application MIME types
 */
export class ApplicationMimeProcessor implements MimeProcessor {
    canHandle(mimeType: string): boolean {
        return mimeType.startsWith('application/') && mimeType !== 'application/json';
    }

    processForDeepnote(content: unknown): unknown {
        if (typeof content === 'string') {
            return parseJsonSafely(content);
        }
        return content;
    }

    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null {
        const textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return NotebookCellOutputItem.text(textContent, mimeType);
    }
}

/**
 * Generic fallback processor
 */
export class GenericMimeProcessor implements MimeProcessor {
    canHandle(): boolean {
        return true; // Always can handle as fallback
    }

    processForDeepnote(content: unknown): unknown {
        return content;
    }

    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null {
        return NotebookCellOutputItem.text(String(content), mimeType);
    }
}

/**
 * Registry for MIME type processors
 */
export class MimeTypeProcessorRegistry {
    private readonly processors: MimeProcessor[] = [
        new TextMimeProcessor(),
        new ImageMimeProcessor(),
        new JsonMimeProcessor(),
        new ApplicationMimeProcessor(),
        new GenericMimeProcessor() // Must be last as fallback
    ];

    getProcessor(mimeType: string): MimeProcessor {
        return this.processors.find((processor) => processor.canHandle(mimeType)) || new GenericMimeProcessor();
    }

    processForDeepnote(content: unknown, mimeType: string): unknown {
        const processor = this.getProcessor(mimeType);
        return processor.processForDeepnote(content, mimeType);
    }

    processForVSCode(content: unknown, mimeType: string): NotebookCellOutputItem | null {
        const processor = this.getProcessor(mimeType);
        return processor.processForVSCode(content, mimeType);
    }
}
