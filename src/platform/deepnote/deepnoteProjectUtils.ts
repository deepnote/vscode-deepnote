import { Uri } from 'vscode';

export function notebookPathToDeepnoteProjectFilePath(notebookPath: Uri): Uri {
    return notebookPath.with({ query: '', fragment: '' });
}
