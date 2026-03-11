import {
    Disposable,
    NotebookCell,
    NotebookDocument,
    OverviewRulerLane,
    Range,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
    window,
    workspace
} from 'vscode';
import { injectable } from 'inversify';

import { IExtensionSyncActivationService } from '../../platform/activation/types';

const NOTEBOOK_CELL_SCHEME = 'vscode-notebook-cell';

/**
 * Applies visual decorations (left border, background tint, reduced opacity) to
 * code cell editors that belong to ephemeral blocks (`is_ephemeral: true`).
 *
 * The left border is rendered via a `before` pseudo-element on each line,
 * which avoids overlapping or shifting the code text.
 *
 * Markup cells are handled separately by the markdown-it renderer plugin in
 * `src/renderers/client/markdown.ts`.
 */
@injectable()
export class EphemeralCellDecorationProvider implements IExtensionSyncActivationService {
    private readonly disposables: Disposable[] = [];

    private ephemeralDecorationType!: TextEditorDecorationType;

    public activate(): void {
        this.ephemeralDecorationType = window.createTextEditorDecorationType({
            opacity: '0.8',
            isWholeLine: true,
            overviewRulerColor: new ThemeColor('charts.yellow'),
            overviewRulerLane: OverviewRulerLane.Left,
            before: {
                contentText: '\u200B',
                width: '3px',
                backgroundColor: new ThemeColor('charts.yellow'),
                margin: '0 8px 0 0'
            }
        });

        this.disposables.push(this.ephemeralDecorationType);

        this.disposables.push(
            window.onDidChangeVisibleTextEditors(() => {
                this.updateDecorations();
            })
        );

        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e) => {
                if (e.notebook.notebookType === 'deepnote') {
                    this.updateDecorations();
                }
            })
        );

        this.updateDecorations();
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    private findCellForEditor(editor: TextEditor): NotebookCell | undefined {
        const uri = editor.document.uri;
        if (uri.scheme !== NOTEBOOK_CELL_SCHEME) {
            return undefined;
        }

        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== 'deepnote') {
                continue;
            }

            const cell = this.findMatchingCell(notebook, editor);
            if (cell) {
                return cell;
            }
        }

        return undefined;
    }

    private findMatchingCell(notebook: NotebookDocument, editor: TextEditor): NotebookCell | undefined {
        for (const cell of notebook.getCells()) {
            if (cell.document.uri.toString() === editor.document.uri.toString()) {
                return cell;
            }
        }

        return undefined;
    }

    private updateDecorations(): void {
        for (const editor of window.visibleTextEditors) {
            if (editor.document.uri.scheme !== NOTEBOOK_CELL_SCHEME) {
                continue;
            }

            const cell = this.findCellForEditor(editor);
            if (!cell || cell.metadata?.is_ephemeral !== true) {
                editor.setDecorations(this.ephemeralDecorationType, []);
                continue;
            }

            const lineRanges: Range[] = [];
            for (let i = 0; i < editor.document.lineCount; i++) {
                const line = editor.document.lineAt(i);
                lineRanges.push(line.range);
            }

            editor.setDecorations(this.ephemeralDecorationType, lineRanges);
        }
    }
}
