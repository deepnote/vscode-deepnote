// Re-export the platform-layer reader so there is a single source of truth for
// reading and parsing `.deepnote` files (see src/platform/deepnote/deepnoteProjectFileReader.ts).
export { readDeepnoteProjectFile } from '../../platform/deepnote/deepnoteProjectFileReader';
export { getNotebookKey } from '../../platform/deepnote/deepnoteProjectUtils';

/**
 * Compute a hash of the requirements to detect changes.
 * Returns a sorted, normalized string representation of requirements.
 */
export function computeRequirementsHash(requirements: unknown): string {
    if (!requirements || !Array.isArray(requirements)) {
        return '';
    }

    // Normalize requirements: filter strings, trim, remove empty, dedupe, and sort for consistency
    const normalizedRequirements = Array.from(
        new Set(
            requirements
                .filter((req): req is string => typeof req === 'string')
                .map((req) => req.trim())
                .filter((req) => req.length > 0)
        )
    ).sort();

    return normalizedRequirements.join('|');
}
