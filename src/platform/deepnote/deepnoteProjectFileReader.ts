import { deserializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { Uri, workspace } from 'vscode';

/**
 * Reads a `.deepnote` file from disk and parses it into a {@link DeepnoteFile}.
 *
 * This is the single source of truth for turning a file URI into a parsed Deepnote
 * project: it reads the bytes via `workspace.fs`, decodes them as UTF-8, and parses
 * them with `@deepnote/blocks`' `deserializeDeepnoteFile`.
 *
 * @param fileUri The URI of the `.deepnote` file to read.
 * @returns The parsed Deepnote file.
 */
export async function readDeepnoteProjectFile(fileUri: Uri): Promise<DeepnoteFile> {
    const fileContent = await workspace.fs.readFile(fileUri);
    const yamlContent = new TextDecoder().decode(fileContent);

    return deserializeDeepnoteFile(yamlContent);
}
