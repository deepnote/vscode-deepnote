import { Uri } from 'vscode';

export function getNotebookKey(uri: Uri): string {
    return uri.toString();
}

export function notebookPathToDeepnoteProjectFilePath(notebookPath: Uri): Uri {
    return notebookPath.with({ query: '', fragment: '' });
}
