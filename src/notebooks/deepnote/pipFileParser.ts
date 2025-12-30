/**
 * Parses pip freeze output into a package name/version map.
 *
 * Handles:
 * - Standard format: package==version
 * - File URL format: package @ file:///path
 * - Skips editable installs (-e ...)
 * - Skips comments and blank lines
 * - Normalizes package names to lowercase
 */
export function parsePipFreezeFile(content: string): Record<string, string> {
    const packages: Record<string, string> = {};

    for (const line of content.split('\n')) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        // Skip editable installs: -e git+https://... or -e .
        if (trimmed.startsWith('-e ')) {
            continue;
        }

        // Handle standard format: package==version
        const eqMatch = trimmed.match(/^([a-zA-Z0-9._-]+)==(.+)$/);

        if (eqMatch) {
            packages[eqMatch[1].toLowerCase()] = eqMatch[2];

            continue;
        }

        // Handle @ format: package @ file:///path
        const atMatch = trimmed.match(/^([a-zA-Z0-9._-]+)\s*@\s*(.+)$/);

        if (atMatch) {
            packages[atMatch[1].toLowerCase()] = atMatch[2];
        }
    }

    return packages;
}
