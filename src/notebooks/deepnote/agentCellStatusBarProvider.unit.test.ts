import { assert, expect } from 'chai';
import * as sinon from 'sinon';
import { anything, verify, when } from 'ts-mockito';
import { CancellationToken, NotebookCell, NotebookEdit, WorkspaceEdit } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { AgentCellStatusBarProvider } from './agentCellStatusBarProvider';
import { createMockCell, createMockNotebookWithCells } from './deepnoteTestHelpers';

suite('AgentCellStatusBarProvider', () => {
    let provider: AgentCellStatusBarProvider;
    let mockToken: CancellationToken;

    setup(() => {
        mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        } as any;
        provider = new AgentCellStatusBarProvider();
    });

    teardown(() => {
        provider.dispose();
    });

    suite('Agent Cell Detection', () => {
        test('Should return status bar items for agent cell', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.not.be.undefined;
            expect(items).to.have.lengthOf(2);
        });

        test('Should return undefined for code cell', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'code' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for sql cell', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'sql' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for markdown cell', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'markdown' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for cell without pocket', () => {
            const cell = createMockCell({ metadata: {} });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined for cell without metadata', () => {
            const cell = createMockCell({ metadata: undefined });
            const items = provider.provideCellStatusBarItems(cell, mockToken);

            expect(items).to.be.undefined;
        });

        test('Should return undefined when cancellation is requested', () => {
            const cancelledToken: CancellationToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: () => undefined })
            } as any;
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, cancelledToken);

            expect(items).to.be.undefined;
        });
    });

    suite('Agent Block Indicator', () => {
        test('Should display agent block label with icon and no command', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[0].text).to.include('$(hubot)');
            expect(items[0].text).to.include('Agent Block');
            expect(items[0].alignment).to.equal(1);
            expect(items[0].priority).to.equal(100);
            expect(items[0].command).to.be.undefined;
        });
    });

    suite('Model Picker', () => {
        test('Should display default model picker for agent cell without model metadata', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: auto');
            expect(items[1].text).to.include('$(symbol-enum)');
            expect(items[1].command).to.not.be.undefined;
            const cmd = items[1].command as any;
            expect(cmd.command).to.equal('deepnote.switchAgentModel');
            expect(items[1].priority).to.equal(90);
        });

        test('Should display configured model from metadata', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_agent_model: 'gpt-5.6-sol',
                    deepnote_max_iterations: 50
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: gpt-5.6-sol');
        });

        test('Should display "auto" when model is empty string', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_agent_model: ''
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: auto');
        });
    });

    suite('Model Switching', () => {
        let capturedEdit: { index: number; metadata: Record<string, unknown> } | undefined;

        setup(() => {
            resetVSCodeMocks();
            capturedEdit = undefined;

            // The vscode mock's NotebookEdit.updateCellMetadata discards its metadata argument, so
            // capturing the WorkspaceEdit cannot show what was written. Stub the static instead.
            sinon.stub(NotebookEdit, 'updateCellMetadata').callsFake((index: number, metadata) => {
                capturedEdit = { index, metadata: metadata as Record<string, unknown> };

                return {} as NotebookEdit;
            });
        });

        teardown(() => {
            sinon.restore();
            resetVSCodeMocks();
        });

        function agentCell(): NotebookCell {
            return createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent', id: 'pocket-1' },
                    id: 'block-1',
                    deepnote_agent_model: 'gpt-5.6-sol'
                },
                index: 2
            });
        }

        function pick(label: string | undefined) {
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(label === undefined ? undefined : ({ label } as any))
            );
        }

        test('Should write the picked model without dropping the cell’s other metadata', async () => {
            // Catches: an inverted spread in updateCellMetadata, which makes the switch a silent
            // no-op while still calling applyEdit — so a call-count assertion would not notice.
            pick('gpt-5.6-terra');
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            await provider.switchModel(agentCell());

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            expect(capturedEdit!.index).to.equal(2);
            expect(capturedEdit!.metadata).to.deep.equal({
                __deepnotePocket: { type: 'agent', id: 'pocket-1' },
                id: 'block-1',
                deepnote_agent_model: 'gpt-5.6-terra'
            });
        });

        test('Should not edit the notebook when the current model is re-picked', async () => {
            // Catches: losing the `selected.label === currentModel` guard, which dirties the
            // document on a no-op selection.
            pick('gpt-5.6-sol');

            await provider.switchModel(agentCell());

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should not edit the notebook when the picker is dismissed', async () => {
            // Catches: losing the `!selected` guard, which throws on `selected.label` when the
            // user presses Escape.
            pick(undefined);

            await provider.switchModel(agentCell());

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should report an error when the workspace edit is rejected', async () => {
            // Catches: dropping the `if (!success)` branch, which loses the model change silently.
            pick('gpt-5.6-luna');
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            let statusBarRefreshed = false;
            provider.onDidChangeCellStatusBarItems(() => {
                statusBarRefreshed = true;
            });

            await provider.switchModel(agentCell());

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            expect(statusBarRefreshed, 'a rejected edit must not refresh the status bar').to.be.false;
        });

        test('Should ignore a non-agent cell', async () => {
            // Catches: dropping the isAgentCell guard, which would offer the model picker on any cell.
            pick('gpt-5.6-luna');

            await provider.switchModel(createMockCell({ metadata: { __deepnotePocket: { type: 'code' } } }));

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
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

        function agentBlock(text: string, blockId: string) {
            return { text, metadata: { __deepnotePocket: { type: 'agent' }, id: blockId } };
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

        test('Should delete every cell this agent block generated and nothing else', async () => {
            const { cells } = createMockNotebookWithCells([
                agentBlock('agent A', 'agent-block-1'),
                ephemeralCell('eph A1', 'agent-block-1'),
                ephemeralCell('eph A2', 'agent-block-1'),
                { text: 'user code', metadata: {} },
                agentBlock('agent B', 'agent-block-2'),
                ephemeralCell('eph B1', 'agent-block-2'),
                ephemeralCell('orphan')
            ]);
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(cells[0]);

            expect(cells.map((cell) => cell.document.getText())).to.deep.equal([
                'agent A',
                'user code',
                'agent B',
                'eph B1',
                'orphan'
            ]);
        });

        test('Should report how many blocks the clear removes', async () => {
            const { cells } = createMockNotebookWithCells([
                agentBlock('agent A', 'agent-block-1'),
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
            const { cells } = createMockNotebookWithCells([
                agentBlock('agent A', 'agent-block-1'),
                ephemeralCell('eph A1', 'agent-block-1')
            ]);
            applyDeletionsTo(cells);
            confirmWith(undefined);

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            expect(cells).to.have.lengthOf(2);
        });

        test('Should not prompt for an agent block that generated nothing', async () => {
            // Catches: prompting to clear 0 blocks when the agent has not run.
            const { cells } = createMockNotebookWithCells([
                agentBlock('agent A', 'agent-block-1'),
                ephemeralCell('eph B1', 'agent-block-2')
            ]);
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).never();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should ignore a cell that is not an agent block', async () => {
            // Catches: dropping the isAgentCell guard, which would clear from any cell whose id
            // happens to own ephemeral children.
            const { cells } = createMockNotebookWithCells([
                { text: 'user code', metadata: { id: 'agent-block-1' } },
                ephemeralCell('eph A1', 'agent-block-1')
            ]);
            applyDeletionsTo(cells);
            confirmWith('Clear');

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).never();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should report an error when the workspace edit is rejected', async () => {
            // Catches: dropping the `if (!applyEdit)` branch, which loses the clear silently.
            const { cells } = createMockNotebookWithCells([
                agentBlock('agent A', 'agent-block-1'),
                ephemeralCell('eph A1', 'agent-block-1')
            ]);
            confirmWith('Clear');
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            await provider.clearEphemeralBlocks(cells[0]);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        suite('Clear button', () => {
            test('Should offer the button on an agent block that generated ephemeral cells', () => {
                const { cells } = createMockNotebookWithCells([
                    agentBlock('agent A', 'agent-block-1'),
                    ephemeralCell('eph A1', 'agent-block-1')
                ]);
                const items = provider.provideCellStatusBarItems(cells[0], mockToken)!;

                expect(items).to.have.lengthOf(3);
                expect(items[2].text).to.include('$(trash)');
                expect(items[2].text).to.include('Clear ephemeral blocks');
                expect(items[2].alignment).to.equal(1);
                expect(items[2].priority).to.equal(80);

                const command = items[2].command as { command: string; arguments: unknown[] };
                expect(command.command).to.equal('deepnote.clearEphemeralBlocks');
                expect(command.arguments).to.deep.equal([cells[0]]);
            });

            test('Should hide the button on an agent block that owns no ephemeral cells', () => {
                // Catches: an always-visible button, which prompts to clear 0 blocks.
                const { cells } = createMockNotebookWithCells([
                    agentBlock('agent A', 'agent-block-1'),
                    ephemeralCell('eph B1', 'agent-block-2')
                ]);
                const items = provider.provideCellStatusBarItems(cells[0], mockToken)!;

                expect(items).to.have.lengthOf(2);
            });
        });

        suite('Command handler', () => {
            let invokeCommand: (cell?: NotebookCell) => Promise<void>;

            setup(() => {
                when(
                    mockedVSCodeNamespaces.notebooks.registerNotebookCellStatusBarItemProvider(anything(), anything())
                ).thenReturn({ dispose: () => undefined });
                when(mockedVSCodeNamespaces.workspace.onDidChangeNotebookDocument).thenReturn(() => ({
                    dispose: () => undefined
                }));
                when(mockedVSCodeNamespaces.commands.registerCommand(anything(), anything())).thenCall(
                    (id: string, callback: (cell?: NotebookCell) => Promise<void>) => {
                        if (id === 'deepnote.clearEphemeralBlocks') {
                            invokeCommand = callback;
                        }

                        return { dispose: () => undefined };
                    }
                );

                provider.activate();
            });

            test('Should clear the blocks of the cell the command is given', async () => {
                const { cells } = createMockNotebookWithCells([
                    agentBlock('agent A', 'agent-block-1'),
                    ephemeralCell('eph A1', 'agent-block-1')
                ]);
                applyDeletionsTo(cells);
                confirmWith('Clear');

                await invokeCommand(cells[0]);

                expect(cells.map((cell) => cell.document.getText())).to.deep.equal(['agent A']);
            });

            test('Should reject when invoked without a cell', async () => {
                // Catches: falling back to the selected cell, which clears a run the user never clicked.
                confirmWith('Clear');

                await assert.isRejected(invokeCommand(undefined), /requires the cell it was invoked from/);

                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).never();
                verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
            });
        });
    });
});
