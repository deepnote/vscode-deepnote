import { DeepnoteFile } from '@deepnote/blocks';
import { Uri, workspace } from 'vscode';
import * as yaml from 'js-yaml';

export async function readDeepnoteProjectFile(fileUri: Uri): Promise<DeepnoteFile> {
    const fileContent = await workspace.fs.readFile(fileUri);
    const yamlContent = new TextDecoder().decode(fileContent);
    const projectData = yaml.load(yamlContent) as DeepnoteFile;
    return projectData;
}
