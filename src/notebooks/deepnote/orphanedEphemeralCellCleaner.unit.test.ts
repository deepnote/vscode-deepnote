import { expect } from 'chai';
import * as sinon from 'sinon';
import { anything, verify, when } from 'ts-mockito';
import { Disposable, NotebookCell, WorkspaceEdit } from 'vscode';

import { IDisposableRegistry } from '../../platform/common/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { createMockNotebookWithCells } from './deepnoteTestHelpers';
import { OrphanedEphemeralCellCleaner } from './orphanedEphemeralCellCleaner';

suite('OrphanedEphemeralCellCleaner', () => {
    let cleaner: OrphanedEphemeralCellCleaner;
    let disposables: Disposable[];
    let notebookChangeHandler: ((e: any) => Promise<void>) | undefined;

    function agentBlock(blockId: string) {
        return { metadata: { __deepnotePocket: { type: 'agent' }, id: blockId } };
    }

    function ephemeralCell(agentSourceBlockId: string) {
        return { metadata: { is_ephemeral: true, agent_source_block_id: agentSourceBlockId } };
    }

    // Mocked WorkspaceEdit.set drops the edits, so capture them on the prototype and replay the
    // deletions against `cells` — an ascending delete order corrupts the survivors, not the count.
    function applyDeletionsTo(cells: NotebookCell[]) {
        let recordedEdits: { range: { start: number; end: number } }[] = [];
        let appliedEdits = 0;

        sinon.stub(WorkspaceEdit.prototype, 'set').callsFake((_uri, edits) => {
            recordedEdits = edits as unknown as { range: { start: number; end: number } }[];
        });

        when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
            appliedEdits++;

            for (const { range } of recordedEdits) {
                cells.splice(range.start, range.end - range.start);
            }

            return Promise.resolve(true);
        });

        return { appliedEdits: () => appliedEdits };
    }

    setup(() => {
        resetVSCodeMocks();
        disposables = [];

        when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).thenCall(
            (handler, thisArg) => {
                notebookChangeHandler = (e: any) => handler.call(thisArg, e);

                return { dispose: () => undefined };
            }
        );

        cleaner = new OrphanedEphemeralCellCleaner(disposables as unknown as IDisposableRegistry);
    });

    teardown(() => {
        sinon.restore();
        notebookChangeHandler = undefined;
        disposables.forEach((d) => d.dispose());
        resetVSCodeMocks();
    });

    test('activate registers an onDidChangeNotebookDocument listener', () => {
        cleaner.activate();

        verify(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument(anything(), anything())).once();
    });

    // The reported regression: deleting the agent block leaves its generated cells behind.
    test('removes the ephemeral cells of an agent block that was deleted', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([
            ephemeralCell('agent-block-1'),
            ephemeralCell('agent-block-1')
        ]);
        const deletedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;
        applyDeletionsTo(cells);

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedAgent], addedCells: [] }]
        });

        expect(cells).to.have.lengthOf(0);
    });

    // Kills an implementation that clears every ephemeral cell once any agent cell disappears,
    // instead of scoping the delete to the id that was actually removed.
    test('keeps the ephemeral cells of an agent block that is still present', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([
            ephemeralCell('agent-block-1'),
            agentBlock('agent-block-2'),
            ephemeralCell('agent-block-2'),
            { metadata: {} }
        ]);
        const deletedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;
        applyDeletionsTo(cells);

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedAgent], addedCells: [] }]
        });

        expect(cells.map((c) => c.metadata)).to.deep.equal([
            agentBlock('agent-block-2').metadata,
            ephemeralCell('agent-block-2').metadata,
            {}
        ]);
    });

    // Catches: dropping the agent-cell gate, which would sweep on every ordinary cell deletion.
    test('applies no edit when the removed cell was not an agent cell', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([ephemeralCell('agent-block-1')]);
        const { appliedEdits } = applyDeletionsTo(cells);
        const deletedCell = { metadata: {}, notebook } as unknown as NotebookCell;

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedCell], addedCells: [] }]
        });

        expect(appliedEdits()).to.equal(0);
        expect(cells).to.have.lengthOf(1);
    });

    // Catches: dropping the notebookType guard, which would mutate Jupyter notebooks too.
    test('ignores non-deepnote notebooks', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([ephemeralCell('agent-block-1')]);
        (notebook as { notebookType: string }).notebookType = 'jupyter-notebook';
        const { appliedEdits } = applyDeletionsTo(cells);
        const deletedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedAgent], addedCells: [] }]
        });

        expect(appliedEdits()).to.equal(0);
    });

    // A drag-reorder is one transactional event that removes and re-adds the same cell. Catches an
    // implementation that deletes based on `removedCells` alone instead of excluding cells that
    // reappear in `addedCells` within the same event.
    test('does not delete anything when the agent cell was only moved', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([ephemeralCell('agent-block-1')]);
        const { appliedEdits } = applyDeletionsTo(cells);
        const movedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;

        await notebookChangeHandler!({
            notebook,
            contentChanges: [
                { removedCells: [movedAgent], addedCells: [] },
                { removedCells: [], addedCells: [movedAgent] }
            ]
        });

        expect(appliedEdits()).to.equal(0);
        expect(cells).to.have.lengthOf(1);
    });

    // A replacement agent block mints a fresh id, so the old scratch can never be reclaimed by the
    // pre-run sweep — this is the only path left that can still collect it.
    test('removes scratch left by a deleted agent block even when a new agent block exists', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([
            agentBlock('agent-block-9'),
            ephemeralCell('agent-block-1')
        ]);
        const deletedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;
        applyDeletionsTo(cells);

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedAgent], addedCells: [] }]
        });

        expect(cells.map((c) => c.metadata)).to.deep.equal([agentBlock('agent-block-9').metadata]);
    });

    // removeEphemeralCellsOwnedBy throws on a rejected edit; nothing awaits this listener, so an
    // uncaught throw here would surface only as an unhandled promise rejection.
    test('does not throw when the delete edit is rejected', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([ephemeralCell('agent-block-1')]);
        const deletedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;
        when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(false));

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedAgent], addedCells: [] }]
        });

        expect(cells).to.have.lengthOf(1);
    });

    // Our own deletion re-enters the listener with the ephemeral cells in removedCells; none of them
    // is an agent cell, so the gate must stop it there rather than looping.
    test('the follow-up event from its own deletion applies no further edit', async () => {
        cleaner.activate();
        const { cells, notebook } = createMockNotebookWithCells([ephemeralCell('agent-block-1')]);
        const { appliedEdits } = applyDeletionsTo(cells);
        const deletedAgent = { ...agentBlock('agent-block-1'), notebook } as unknown as NotebookCell;
        const removedScratch = { ...ephemeralCell('agent-block-1'), notebook } as unknown as NotebookCell;

        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [deletedAgent], addedCells: [] }]
        });
        await notebookChangeHandler!({
            notebook,
            contentChanges: [{ removedCells: [removedScratch], addedCells: [] }]
        });

        expect(appliedEdits()).to.equal(1);
    });
});
