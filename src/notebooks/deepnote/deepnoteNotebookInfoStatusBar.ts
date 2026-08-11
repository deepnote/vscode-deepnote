import { inject, injectable } from 'inversify';
import {
    Disposable,
    NotebookDocument,
    NotebookDocumentChangeEvent,
    NotebookEditor,
    StatusBarAlignment,
    StatusBarItem,
    commands,
    env,
    l10n,
    window,
    workspace
} from 'vscode';

import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { ITelemetryService } from '../../platform/analytics/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { Commands } from '../../platform/common/constants';

const DEEPNOTE_NOTEBOOK_TYPE = 'deepnote';
const STATUS_BAR_PRIORITY = 100;

/**
 * Shows the active Deepnote notebook's name in a left-aligned status bar item. Clicking it copies
 * the notebook's details (name, ids, project, version, URI) to the clipboard.
 *
 * Web-safe: depends only on `window`/`workspace`/`env`/`commands`.
 */
@injectable()
export class DeepnoteNotebookInfoStatusBar implements IExtensionSyncActivationService, Disposable {
    private readonly disposables: Disposable[] = [];

    private statusBarItem: StatusBarItem | undefined;

    constructor(
        @inject(IDisposableRegistry) disposableRegistry: IDisposableRegistry,
        @inject(ITelemetryService) private readonly analytics: ITelemetryService
    ) {
        disposableRegistry.push(this);
    }

    public activate(): void {
        this.statusBarItem = window.createStatusBarItem(
            'deepnote.notebookInfo',
            StatusBarAlignment.Left,
            STATUS_BAR_PRIORITY
        );
        this.statusBarItem.name = l10n.t('Deepnote Notebook');
        this.statusBarItem.command = Commands.CopyNotebookDetails;
        this.statusBarItem.hide();
        this.disposables.push(this.statusBarItem);

        this.disposables.push(
            commands.registerCommand(Commands.CopyNotebookDetails, () => this.copyActiveNotebookDetails())
        );

        window.onDidChangeActiveNotebookEditor(this.handleActiveEditorChanged, this, this.disposables);
        workspace.onDidChangeNotebookDocument(this.handleNotebookDocumentChanged, this, this.disposables);

        this.updateStatusBar();
    }

    public dispose(): void {
        while (this.disposables.length) {
            const disposable = this.disposables.pop();

            try {
                disposable?.dispose();
            } catch {
                // Ignore disposal errors during teardown.
            }
        }
    }

    private handleActiveEditorChanged(_editor: NotebookEditor | undefined): void {
        this.updateStatusBar();
    }

    private handleNotebookDocumentChanged(event: NotebookDocumentChangeEvent): void {
        const activeNotebook = window.activeNotebookEditor?.notebook;

        if (activeNotebook && event.notebook === activeNotebook) {
            this.updateStatusBar();
        }
    }

    private updateStatusBar(): void {
        const item = this.statusBarItem;

        if (!item) {
            return;
        }

        const notebook = window.activeNotebookEditor?.notebook;

        if (!notebook || notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            item.hide();

            return;
        }

        const notebookName = (notebook.metadata?.deepnoteNotebookName as string | undefined) || l10n.t('Untitled');

        item.text = `$(notebook) ${notebookName}`;
        item.tooltip = l10n.t('Copy Active Deepnote Notebook Details');
        item.show();
    }

    private async copyActiveNotebookDetails(): Promise<void> {
        const notebook = window.activeNotebookEditor?.notebook;

        if (!notebook || notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            await window.showWarningMessage(l10n.t('No active Deepnote notebook found.'));

            return;
        }

        const details = this.formatNotebookDetails(notebook);

        await env.clipboard.writeText(details);
        this.analytics.trackEvent({ eventName: 'copy_notebook_details' });
        await window.showInformationMessage(l10n.t('Copied Deepnote notebook details to clipboard.'));
    }

    private formatNotebookDetails(notebook: NotebookDocument): string {
        const metadata = notebook.metadata ?? {};
        const notebookName = (metadata.deepnoteNotebookName as string | undefined) ?? '';
        const notebookId = (metadata.deepnoteNotebookId as string | undefined) ?? '';
        const projectName = (metadata.deepnoteProjectName as string | undefined) ?? '';
        const projectId = (metadata.deepnoteProjectId as string | undefined) ?? '';
        const version = (metadata.deepnoteVersion as string | undefined) ?? '';

        return [
            `Notebook name: ${notebookName}`,
            `Notebook ID: ${notebookId}`,
            `Project name: ${projectName}`,
            `Project ID: ${projectId}`,
            `Version: ${version}`,
            `URI: ${notebook.uri.toString()}`
        ].join('\n');
    }
}
