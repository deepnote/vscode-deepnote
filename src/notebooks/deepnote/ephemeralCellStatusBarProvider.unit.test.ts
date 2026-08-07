import { expect } from 'chai';
import * as sinon from 'sinon';
import { anything, verify, when } from 'ts-mockito';
import { CancellationToken, NotebookCell, WorkspaceEdit } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { EphemeralCellStatusBarProvider } from './ephemeralCellStatusBarProvider';
import { createMockCell, createMockNotebookWithCells } from './deepnoteTestHelpers';

suite('EphemeralCellStatusBarProvider', () => {
    let provider: EphemeralCellStatusBarProvider;
    let mockToken: CancellationToken;

    setup(() => {
        mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        } as any;
        provider = new EphemeralCellStatusBarProvider();
    });

    teardown(() => {
        provider.dispose();
    });

    suite('Ephemeral Cell Detection', () => {
        test('Should return undefined when is_ephemeral is false', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: false } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined when is_ephemeral is not set', () => {
            const cell = createMockCell({ metadata: {} });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for cell without metadata', () => {
            const cell = createMockCell({ metadata: undefined });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined when is_ephemeral is a non-boolean truthy value', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: 'true' } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined when cancellation is requested', () => {
            const cancelledToken: CancellationToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: () => undefined })
            } as any;
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const items = provider.provideCellStatusBarItems(cell, cancelledToken);

            expect(items).to.be.undefined;
        });
    });

    suite('Status Bar Item Properties', () => {
        test('Should set ephemeral status bar item properties', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items).to.have.lengthOf(2);
            expect(items[0].text).to.include('$(sparkle)');
            expect(items[0].text).to.include('Ephemeral');
            expect(items[0].alignment).to.equal(1);
            expect(items[0].priority).to.equal(1000);
            expect(items[0].command).to.be.undefined;
        });

        test('Should set clear button properties and pass the cell to its command', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('$(trash)');
            expect(items[1].text).to.include('Clear ephemeral blocks');
            expect(items[1].alignment).to.equal(1);
            expect(items[1].priority).to.equal(990);

            const command = items[1].command as { command: string; arguments: unknown[] };
            expect(command.command).to.equal('deepnote.clearEphemeralBlocks');
            expect(command.arguments).to.deep.equal([cell]);
        });
    });

    suite('Tooltip', () => {
        test('Should describe ephemeral tooltip without source block when agent_source_block_id is absent', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[0].tooltip).to.include('Auto-generated ephemeral block');
            expect(items[0].tooltip).to.not.include('Source agent block');
        });

        test('Should include agent source block ID in tooltip when present', () => {
            const cell = createMockCell({
                metadata: {
                    is_ephemeral: true,
                    agent_source_block_id: 'a0000000000000000000000000000004'
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[0].tooltip).to.include('a0000000000000000000000000000004');
            expect(items[0].tooltip).to.include('Source agent block');
        });
    });

    suite('Coexistence with other cell types', () => {
        test('Should return items for ephemeral cells regardless of pocket type', () => {
            const pocketTypes = ['agent', 'code', 'markdown'] as const;

            for (const type of pocketTypes) {
                const cell = createMockCell({
                    metadata: {
                        __deepnotePocket: { type },
                        is_ephemeral: true,
                        ...(type === 'agent' ? { agent_source_block_id: 'source-id' } : {})
                    }
                });
                const items = provider.provideCellStatusBarItems(cell, mockToken);

                expect(items).to.not.be.undefined;
            }
        });
    });

    suite('Clearing ephemeral blocks', () => {
        setup(() => {
            resetVSCodeMocks();
        });

        teardown(() => {
            sinon.restore();
            resetVSCodeMocks();
        });

        // Mocked WorkspaceEdit.set drops the edits, so capture them on the prototype and replay the
        // deletions against `cells` — an ascending delete order corrupts the survivors, not the count.
        function applyDeletionsTo(cells: NotebookCell[]): void {
            let recordedEdits: { range: { start: number; end: number } }[] = [];

            sinon.stub(WorkspaceEdit.prototype, 'set').callsFake((_uri, edits) => {
                recordedEdits = edits as unknown as { range: { start: number; end: number } }[];
            });

            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
                for (const { range } of recordedEdits) {
                    cells.splice(range.start, range.end - range.start);
                }

                return Promise.resolve(true);
            });
        }

        function confirmWith(label: string | undefined): void {
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve(label as any)
            );
        }

        function ephemeralCell(text: string, agentSourceBlockId?: string) {
            return {
                text,
                metadata: {
                    is_ephemeral: true,
                    ...(agentSourceBlockId ? { agent_source_block_id: agentSourceBlockId } : {})
                }
            };
        }

        function agentCell(text: string, blockId: string) {
            return { text, metadata: { __deepnotePocket: { type: 'agent' }, id: blockId } };
        }

        test('Should delete every cell generated by the clicked cell’s agent block and nothing else', async () => {
            const { cells } = createMockNotebookWithCells([
                agentCell('agent A', 'agent-block-1'),
                ephemeralCell('eph A1', 'agent-block-1'),
                ephemeralCell('eph A2', 'agent-block-1'),
                { text: 'user code', metadata: {} },
                agentCell('agent B', 'agent-block-2'),
                ephemeralCell('eph B1', 'agent-block-2')
            ]);
            const clickedCell = cells[1];
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(clickedCell);

            expect(cells.map((cell) => cell.document.getText())).to.deep.equal([
                'agent A',
                'user code',
                'agent B',
                'eph B1'
            ]);
        });

        test('Should delete only the clicked cell when it records no source agent block', async () => {
            const { cells } = createMockNotebookWithCells([
                ephemeralCell('orphan'),
                ephemeralCell('eph A1', 'agent-block-1')
            ]);
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(cells[0]);

            expect(cells.map((cell) => cell.document.getText())).to.deep.equal(['eph A1']);
        });

        test('Should report how many blocks the clear removes', async () => {
            const { cells } = createMockNotebookWithCells([
                ephemeralCell('eph A1', 'agent-block-1'),
                ephemeralCell('eph A2', 'agent-block-1')
            ]);
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(cells[0]);

            verify(
                mockedVSCodeNamespaces.window.showWarningMessage(
                    'Clear 2 ephemeral block(s) from this notebook?',
                    anything(),
                    anything()
                )
            ).once();
        });

        test('Should not edit the notebook when the confirmation is dismissed', async () => {
            // Catches: applying the edit before the modal is answered, which deletes on a cancel.
            const { cells } = createMockNotebookWithCells([ephemeralCell('eph A1', 'agent-block-1')]);
            applyDeletionsTo(cells);
            confirmWith(undefined);

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            expect(cells).to.have.lengthOf(1);
        });

        test('Should ignore a cell that is not ephemeral', async () => {
            // Catches: dropping the isEphemeralCell guard, which would offer to clear any cell.
            const { cells } = createMockNotebookWithCells([{ text: 'user code', metadata: {} }]);
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).never();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should report an error when the workspace edit is rejected', async () => {
            // Catches: dropping the `if (!applyEdit)` branch, which loses the clear silently.
            const { cells } = createMockNotebookWithCells([ephemeralCell('eph A1', 'agent-block-1')]);
            confirmWith('Clear');
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });
    });
});
