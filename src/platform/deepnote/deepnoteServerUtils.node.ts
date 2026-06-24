import { Uri } from 'vscode';

export function createDeepnoteServerConfigHandle(environmentId: string, notebookUri: Uri): string {
    return `deepnote-config-server-${environmentId}-${notebookUri.toString()}`;
}
