import { inject, injectable } from 'inversify';
import {
    commands,
    Disposable,
    env,
    l10n,
    NotebookDocument,
    StatusBarAlignment,
    StatusBarItem,
    window,
    workspace
} from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../kernels/deepnote/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { Commands } from '../../platform/common/constants';
import { IDisposableRegistry } from '../../platform/common/types';

/**
 * Shows the active Deepnote notebook name in the status bar; tooltip and copy action include full debug details (metadata and URI).
 */
@injectable()
export class DeepnoteNotebookInfoStatusBar implements IExtensionSyncActivationService, Disposable {
    private readonly disposables: Disposable[] = [];

    private disposed = false;

    private statusBarItem: StatusBarItem | undefined;

    constructor(@inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry) {
        disposableRegistry.push(this);
    }

    public activate(): void {
        this.statusBarItem = window.createStatusBarItem('deepnote.notebookInfo', StatusBarAlignment.Left, 99);
        this.statusBarItem.name = l10n.t('Deepnote Notebook Info');
        this.statusBarItem.command = Commands.CopyNotebookDetails;
        this.disposables.push(this.statusBarItem);

        this.disposables.push(
            commands.registerCommand(Commands.CopyNotebookDetails, () => {
                this.copyActiveNotebookDetails();
            })
        );

        this.disposables.push(window.onDidChangeActiveNotebookEditor(() => this.updateStatusBar()));

        this.disposables.push(
            workspace.onDidChangeNotebookDocument((e) => {
                if (e.notebook === window.activeNotebookEditor?.notebook) {
                    this.updateStatusBar();
                }
            })
        );

        this.updateStatusBar();
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        while (this.disposables.length) {
            const disposable = this.disposables.pop();

            try {
                disposable?.dispose();
            } catch {
                // ignore
            }
        }
    }

    private copyActiveNotebookDetails(): void {
        const notebook = window.activeNotebookEditor?.notebook;

        if (!notebook) {
            return;
        }

        const info = this.getNotebookDebugInfo(notebook);

        if (!info) {
            return;
        }

        void env.clipboard.writeText(info.detailsText);
        void window.showInformationMessage(l10n.t('Copied notebook details to clipboard.'));
    }

    private getNotebookDebugInfo(notebook: NotebookDocument): { detailsText: string; displayName: string } | undefined {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return undefined;
        }

        const metadata = notebook.metadata as {
            deepnoteNotebookId?: string;
            deepnoteNotebookName?: string;
            deepnoteProjectId?: string;
            deepnoteProjectName?: string;
            deepnoteVersion?: string;
            name?: string;
        };

        const displayName = metadata.deepnoteNotebookName ?? metadata.name ?? l10n.t('Deepnote notebook');
        const uriString = notebook.uri.toString(true);

        const lines: string[] = [
            l10n.t('Notebook: {0}', displayName),
            l10n.t('Notebook ID: {0}', metadata.deepnoteNotebookId ?? l10n.t('(unknown)')),
            l10n.t('Project: {0}', metadata.deepnoteProjectName ?? l10n.t('(unknown)')),
            l10n.t('Project ID: {0}', metadata.deepnoteProjectId ?? l10n.t('(unknown)'))
        ];

        if (metadata.deepnoteVersion !== undefined) {
            lines.push(l10n.t('Deepnote version: {0}', String(metadata.deepnoteVersion)));
        }

        lines.push(l10n.t('URI: {0}', uriString));

        return { detailsText: lines.join('\n'), displayName };
    }

    private updateStatusBar(): void {
        const item = this.statusBarItem;

        if (!item) {
            return;
        }

        const editor = window.activeNotebookEditor;

        if (!editor) {
            item.hide();

            return;
        }

        const info = this.getNotebookDebugInfo(editor.notebook);

        if (!info) {
            item.hide();

            return;
        }

        item.text = `$(notebook) ${info.displayName}`;
        item.tooltip = [info.detailsText, l10n.t('Click to copy details')].join('\n');
        item.show();
    }
}
