import { inject, injectable } from 'inversify';
import { languages, NotebookCellKind, NotebookDocumentChangeEvent, workspace } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../kernels/deepnote/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { PYTHON_LANGUAGE } from '../../platform/common/constants';
import { IDisposableRegistry } from '../../platform/common/types';
import { noop } from '../../platform/common/utils/misc';

/**
 * Ensures newly added code cells in Deepnote notebooks default to Python language.
 * VS Code copies the language from adjacent cells when inserting, which causes
 * new cells after SQL blocks to be SQL. This service corrects that by resetting
 * unintentional language inheritance to Python.
 */
@injectable()
export class DeepnoteNewCellLanguageService implements IExtensionSyncActivationService {
    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {}

    public activate(): void {
        this.disposables.push(workspace.onDidChangeNotebookDocument(this.onDidChangeNotebookDocument, this));
    }

    private async onDidChangeNotebookDocument(e: NotebookDocumentChangeEvent): Promise<void> {
        if (e.notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        for (const change of e.contentChanges) {
            for (const cell of change.addedCells) {
                if (cell.kind !== NotebookCellKind.Code) {
                    continue;
                }

                if (cell.document.getText().trim().length > 0) {
                    continue;
                }

                const pocketType = cell.metadata?.__deepnotePocket?.type;

                if (pocketType) {
                    continue;
                }

                // TODO: This will have to be revisited if we add support for other languages in Deepnote.
                if (cell.document.languageId !== PYTHON_LANGUAGE) {
                    languages.setTextDocumentLanguage(cell.document, PYTHON_LANGUAGE).then(noop, noop);
                }
            }
        }
    }
}
