/**
 * Utility functions for data transformation in Deepnote conversion
 */

/**
 * Safely decode content using TextDecoder
 */
export function decodeContent(data: Uint8Array): string {
    return new TextDecoder().decode(data);
}

/**
 * Safely parse JSON with fallback to original content
 */
export function parseJsonSafely(content: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        return content;
    }
}

/**
 * Convert base64 string to Uint8Array
 */
export function convertBase64ToUint8Array(base64Content: string): Uint8Array {
    const base64Data = base64Content.includes(',') ? base64Content.split(',')[1] : base64Content;
    const binaryString = atob(base64Data);
    const uint8Array = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        uint8Array[i] = binaryString.charCodeAt(i);
    }
    return uint8Array;
}

/**
 * Convert Uint8Array to base64 data URL
 */
export function convertUint8ArrayToBase64DataUrl(data: Uint8Array, mimeType: string): string {
    const base64String = btoa(String.fromCharCode(...data));
    return `data:${mimeType};base64,${base64String}`;
}

/**
 * Merge metadata objects, filtering out undefined values
 */
export function mergeMetadata(...metadataObjects: (Record<string, unknown> | undefined)[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const metadata of metadataObjects) {
        if (metadata) {
            Object.entries(metadata).forEach(([key, value]) => {
                if (value !== undefined) {
                    result[key] = value;
                }
            });
        }
    }

    return result;
}

/**
 * Check if metadata object has any content
 */
export function hasMetadataContent(metadata: Record<string, unknown>): boolean {
    return Object.keys(metadata).length > 0;
}

/**
 * Generate a random hex ID for blocks
 */
export function generateBlockId(): string {
    const chars = '0123456789abcdef';
    let id = '';
    for (let i = 0; i < 32; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

/**
 * Generate sorting key based on index
 */
export function generateSortingKey(index: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const letterIndex = Math.floor(index / 100);
    const letter = letterIndex < alphabet.length ? alphabet[letterIndex] : 'z';
    const number = index % 100;
    return `${letter}${number}`;
}
