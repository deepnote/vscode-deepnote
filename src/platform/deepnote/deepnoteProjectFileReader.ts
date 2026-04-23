import { deserializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';
import { Uri, workspace } from 'vscode';

export async function readDeepnoteProjectFile(fileUri: Uri): Promise<DeepnoteFile> {
    const fileContent = await workspace.fs.readFile(fileUri);
    const yamlContent = new TextDecoder().decode(fileContent);
    return deserializeDeepnoteFile(yamlContent);
}
