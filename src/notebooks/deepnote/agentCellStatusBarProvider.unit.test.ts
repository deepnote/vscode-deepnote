import { expect } from 'chai';
import * as sinon from 'sinon';
import { anything, verify, when } from 'ts-mockito';
import { CancellationToken, NotebookCell, NotebookEdit } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { AgentCellStatusBarProvider } from './agentCellStatusBarProvider';
import { createMockCell } from './deepnoteTestHelpers';

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
                    deepnote_agent_model: 'gpt-4o',
                    deepnote_max_iterations: 50
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: gpt-4o');
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
                    deepnote_agent_model: 'gpt-4o'
                },
                index: 2
            });
        }

        function pick(label: string | undefined) {
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenReturn(
                Promise.resolve(label === undefined ? undefined : ({ label } as any))
            );
        }

        function switchModel(cell: NotebookCell): Promise<void> {
            return (provider as unknown as { switchModel(cell: NotebookCell): Promise<void> }).switchModel(cell);
        }

        test('Should write the picked model without dropping the cell’s other metadata', async () => {
            // Catches: an inverted spread in updateCellMetadata, which makes the switch a silent
            // no-op while still calling applyEdit — so a call-count assertion would not notice.
            pick('gpt-5');
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(true));

            await switchModel(agentCell());

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
            expect(capturedEdit!.index).to.equal(2);
            expect(capturedEdit!.metadata).to.deep.equal({
                __deepnotePocket: { type: 'agent', id: 'pocket-1' },
                id: 'block-1',
                deepnote_agent_model: 'gpt-5'
            });
        });

        test('Should not edit the notebook when the current model is re-picked', async () => {
            // Catches: losing the `selected.label === currentModel` guard, which dirties the
            // document on a no-op selection.
            pick('gpt-4o');

            await switchModel(agentCell());

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should not edit the notebook when the picker is dismissed', async () => {
            // Catches: losing the `!selected` guard, which throws on `selected.label` when the
            // user presses Escape.
            pick(undefined);

            await switchModel(agentCell());

            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });

        test('Should report an error when the workspace edit is rejected', async () => {
            // Catches: dropping the `if (!success)` branch, which loses the model change silently.
            pick('gpt-5');
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReturn(Promise.resolve(false));

            let statusBarRefreshed = false;
            provider.onDidChangeCellStatusBarItems(() => {
                statusBarRefreshed = true;
            });

            await switchModel(agentCell());

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
            expect(statusBarRefreshed, 'a rejected edit must not refresh the status bar').to.be.false;
        });

        test('Should ignore a non-agent cell', async () => {
            // Catches: dropping the isAgentCell guard, which would offer the model picker on any cell.
            pick('gpt-5');

            await switchModel(createMockCell({ metadata: { __deepnotePocket: { type: 'code' } } }));

            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).never();
            verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).never();
        });
    });
});
