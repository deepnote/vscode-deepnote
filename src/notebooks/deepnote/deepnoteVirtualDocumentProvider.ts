import { CancellationToken, Event, EventEmitter, TextDocumentContentProvider, Uri, workspace } from 'vscode';
import * as yaml from 'js-yaml';
import type { DeepnoteProject } from './deepnoteTypes';
import { DeepnoteDataConverter } from './deepnoteDataConverter';

export class DeepnoteVirtualDocumentProvider implements TextDocumentContentProvider {
    private onDidChangeEmitter = new EventEmitter<Uri>();
    private converter = new DeepnoteDataConverter();

    readonly onDidChange: Event<Uri> = this.onDidChangeEmitter.event;

    async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string> {
        if (token.isCancellationRequested) {
            throw new Error('Content provision cancelled');
        }

        const { filePath, notebookId } = this.parseVirtualUri(uri);

        try {
            const fileUri = Uri.file(filePath);
            const rawContent = await workspace.fs.readFile(fileUri);
            const contentString = new TextDecoder('utf-8').decode(rawContent);
            const deepnoteProject = yaml.load(contentString) as DeepnoteProject;

            if (!deepnoteProject.project?.notebooks) {
                throw new Error('Invalid Deepnote file: no notebooks found');
            }

            const selectedNotebook = deepnoteProject.project.notebooks.find((nb) => nb.id === notebookId);

            if (!selectedNotebook) {
                throw new Error(`Notebook with ID ${notebookId} not found`);
            }

            const cells = this.converter.convertBlocksToCells(selectedNotebook.blocks);

            const notebookData = {
                cells,
                metadata: {
                    deepnoteProjectId: deepnoteProject.project.id,
                    deepnoteProjectName: deepnoteProject.project.name,
                    deepnoteNotebookId: selectedNotebook.id,
                    deepnoteNotebookName: selectedNotebook.name,
                    deepnoteVersion: deepnoteProject.version,
                    deepnoteFilePath: filePath
                }
            };

            return JSON.stringify(notebookData, null, 2);
        } catch (error) {
            console.error('Error providing virtual document content:', error);
            throw new Error(`Failed to provide content: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private parseVirtualUri(uri: Uri): { filePath: string; notebookId: string } {
        const query = new URLSearchParams(uri.query);
        const filePath = query.get('filePath');
        const notebookId = query.get('notebookId');

        if (!filePath || !notebookId) {
            throw new Error('Invalid virtual URI: missing filePath or notebookId');
        }

        return { filePath, notebookId };
    }

    public static createVirtualUri(filePath: string, notebookId: string): Uri {
        const query = new URLSearchParams({
            filePath,
            notebookId
        });

        return Uri.parse(`deepnotenotebook://${notebookId}?${query.toString()}`);
    }

    public fireDidChange(uri: Uri): void {
        this.onDidChangeEmitter.fire(uri);
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
