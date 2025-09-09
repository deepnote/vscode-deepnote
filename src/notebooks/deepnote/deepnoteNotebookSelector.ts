import { l10n, type QuickPickItem, window } from 'vscode';

import { toPromise } from '../../platform/common/utils/events';
import type { DeepnoteNotebook } from './deepnoteTypes';

interface NotebookQuickPickItem extends QuickPickItem {
    notebook: DeepnoteNotebook;
}

export class DeepnoteNotebookSelector {
    async selectNotebook(
        notebooks: DeepnoteNotebook[],
        currentNotebookId?: string,
        options?: {
            title?: string;
            placeHolder?: string;
        }
    ): Promise<DeepnoteNotebook | undefined> {
        const items: NotebookQuickPickItem[] = notebooks.map((notebook) => ({
            label: notebook.name,
            description: this.getDescription(notebook, currentNotebookId),
            detail: this.getDetail(notebook),
            notebook
        }));

        // Use createQuickPick for more control over selection
        const quickPick = window.createQuickPick<NotebookQuickPickItem>();
        quickPick.items = items;
        quickPick.placeholder = options?.placeHolder || l10n.t('Select a notebook to open');
        quickPick.title = options?.title || l10n.t('Select Notebook');
        quickPick.ignoreFocusOut = false;

        // Pre-select the current notebook if provided
        if (currentNotebookId) {
            const activeItem = items.find(item => item.notebook.id === currentNotebookId);
            if (activeItem) {
                quickPick.activeItems = [activeItem];
            }
        }

        let accepted = false;
        quickPick.show();
        
        await Promise.race([
            toPromise(quickPick.onDidAccept).then(() => (accepted = true)),
            toPromise(quickPick.onDidHide)
        ]);

        const selectedItem = accepted ? quickPick.selectedItems[0] : undefined;
        quickPick.dispose();
        
        return selectedItem?.notebook;
    }

    private getDescription(notebook: DeepnoteNotebook, currentNotebookId?: string): string {
        const cellCount = notebook.blocks.length;

        if (notebook.id === currentNotebookId) {
            return l10n.t('{0} cells (current)', cellCount);
        }

        return l10n.t('{0} cells', cellCount);
    }

    private getDetail(notebook: DeepnoteNotebook): string {
        if (notebook.workingDirectory) {
            return l10n.t(
                'ID: {0} | Working Directory: {1}',
                notebook.id,
                notebook.workingDirectory
            );
        }

        return l10n.t('ID: {0}', notebook.id);
    }
}
