import { inject, injectable } from 'inversify';
import { NotebookDocumentChangeEvent, workspace } from 'vscode';

import { DEEPNOTE_NOTEBOOK_TYPE } from '../../kernels/deepnote/constants';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IDisposableRegistry } from '../../platform/common/types';
import { logger } from '../../platform/logging';
import { getBlockId, isAgentCell } from './dataConversionUtils';
import { removeEphemeralCellsOwnedBy } from './ephemeralCellCleanup';

/**
 * Deletes ephemeral cells once the agent block that owns them is gone. Nothing else reacts to that:
 * the "Clear ephemeral blocks" button lives on the agent cell itself and disappears with it, and the
 * pre-run sweep in `agentCellExecutionHandler` only ever scopes to agent blocks still present in the
 * batch it is given. Left alone, the orphans stay fully rendered and executable, and a replacement
 * agent block mints a fresh id that can never match them again.
 */
@injectable()
export class OrphanedEphemeralCellCleaner implements IExtensionSyncActivationService {
    constructor(@inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry) {}

    public activate(): void {
        this.disposables.push(workspace.onDidChangeNotebookDocument(this.onDidChangeNotebookDocument, this));
    }

    private async onDidChangeNotebookDocument(e: NotebookDocumentChangeEvent): Promise<void> {
        if (e.notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        // A drag-reorder is one transactional event with a delete-splice and an insert-splice for the
        // SAME cell (VS Code models a move that way), so an agent block that only moved must not be
        // treated as deleted.
        const movedBackIds = new Set(
            e.contentChanges.flatMap((change) =>
                change.addedCells
                    .filter(isAgentCell)
                    .map(getBlockId)
                    .filter((id) => id != null)
            )
        );

        const deletedAgentBlockIds = new Set(
            e.contentChanges
                .flatMap((change) => change.removedCells)
                .filter(isAgentCell)
                .map(getBlockId)
                .filter((id) => id != null)
                .filter((id) => !movedBackIds.has(id))
        );

        if (deletedAgentBlockIds.size === 0) {
            return;
        }

        try {
            await removeEphemeralCellsOwnedBy(e.notebook, deletedAgentBlockIds);
        } catch (error) {
            logger.error('Failed to remove orphaned ephemeral cells', error);
        }
    }
}
