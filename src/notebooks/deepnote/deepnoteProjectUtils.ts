import { deserializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { Uri, workspace } from 'vscode';

export async function readDeepnoteProjectFile(fileUri: Uri): Promise<DeepnoteFile> {
    const fileContent = await workspace.fs.readFile(fileUri);
    const yamlContent = new TextDecoder().decode(fileContent);
    const projectData = deserializeDeepnoteFile(yamlContent);
    return projectData;
}

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
