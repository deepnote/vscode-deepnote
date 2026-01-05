/**
 * Utility functions for Deepnote block ID and sorting key generation
 */

export function parseJsonWithFallback(value: string, fallback?: unknown): unknown | null {
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback ?? null;
    }
}

/**
 * Generate a random hex ID for blocks (32 character hex string)
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
 * Generate sorting key based on index (format: a0, a1, ..., a99, b0, b1, ...)
 */
export function generateSortingKey(index: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const letterIndex = Math.floor(index / 100);
    const letter = letterIndex < alphabet.length ? alphabet[letterIndex] : 'z';
    const number = index % 100;
    return `${letter}${number}`;
}
