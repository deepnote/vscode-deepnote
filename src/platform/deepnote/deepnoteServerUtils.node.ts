import { Uri } from 'vscode';

export function createDeepnoteServerConfigHandle(environmentId: string, deepnoteFileUri: Uri): string {
    return `deepnote-config-server-${environmentId}-${deepnoteFileUri.fsPath}`;
}
