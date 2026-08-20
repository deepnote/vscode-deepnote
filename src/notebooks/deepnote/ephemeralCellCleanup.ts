import { NotebookCell, NotebookDocument, NotebookEdit, NotebookRange, WorkspaceEdit, workspace } from 'vscode';

import { logger } from '../../platform/logging';
import { getEphemeralCellAgentSourceBlockId } from './dataConversionUtils';

/**
 * Deletes ephemeral cells owned by any block in `agentBlockIds`, scanning the whole notebook — not
 * just a caller's batch — so scratch left outside a run's cell selection still gets cleaned up.
 * Returns the cells that were deleted. Edit failures are logged, not thrown.
 */
export async function removeEphemeralCellsOwnedBy(
    notebook: NotebookDocument,
    agentBlockIds: Set<string>
): Promise<Set<NotebookCell>> {
    const deletions: NotebookEdit[] = [];
    const deletedCells = new Set<NotebookCell>();

    for (const cell of notebook.getCells()) {
        const owner = getEphemeralCellAgentSourceBlockId(cell);

        if (owner !== undefined && agentBlockIds.has(owner)) {
            deletions.push(NotebookEdit.deleteCells(new NotebookRange(cell.index, cell.index + 1)));
            deletedCells.add(cell);
        }
    }

    // Applied in this order, so it must be descending — otherwise an earlier deletion shifts the
    // index a later one still needs.
    deletions.reverse();

    if (deletions.length === 0) {
        return deletedCells;
    }

    const edit = new WorkspaceEdit();
    edit.set(notebook.uri, deletions);

    if (await workspace.applyEdit(edit)) {
        logger.info(`Removed ${deletions.length} ephemeral cell(s) owned by ${agentBlockIds.size} agent block(s)`);
    } else {
        logger.error(`Failed to remove ephemeral cells owned by agent block(s) ${[...agentBlockIds].join(', ')}`);
    }

    return deletedCells;
}
