import { deserializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { Uri, workspace } from 'vscode';

/**
 * Reads and parses a `.deepnote` file into a {@link DeepnoteFile}. The single source of truth for
 * turning a file URI into a parsed Deepnote project — use this instead of ad-hoc reads.
 */
export async function readDeepnoteProjectFile(fileUri: Uri): Promise<DeepnoteFile> {
    const fileContent = await workspace.fs.readFile(fileUri);
    const yamlContent = new TextDecoder().decode(fileContent);

    return deserializeDeepnoteFile(yamlContent);
}
