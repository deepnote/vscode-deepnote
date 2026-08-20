import { expect } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, reset, verify, when } from 'ts-mockito';
import {
    CancellationError,
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    NotebookCell,
    NotebookCellData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookController,
    NotebookDocument,
    WorkspaceEdit
} from 'vscode';

import type { AgentBlock } from '@deepnote/blocks';
import type { AgentBlockContext } from '@deepnote/runtime-core';

import { IEncryptedStorage } from '../../platform/common/application/types';
import type { IDisposable } from '../../platform/common/types';
import { dispose } from '../../platform/common/utils/lifecycle';
import { ServiceContainer } from '../../platform/ioc/container';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { mockedVSCodeNamespaces } from '../../test/vscode-mock';
import {
    describeExecutionOutputs,
    EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS,
    executeAgentCell,
    executeEphemeralCell,
    removeEphemeralCellsForAgentBlocks
} from './agentCellExecutionHandler';
import { IDeepnoteNotebookManager } from '../types';
import { createDeepnoteFile, createDeepnoteProject, createMockCell, createMockNotebook } from './deepnoteTestHelpers';

// Key namespacing is EncryptedStorage's job and is covered in deepnoteSecretStore.unit.test.ts.
function createEncryptedStorageFake(secretStorage: Map<string, string>): IEncryptedStorage {
    const encryptedStorage = mock<IEncryptedStorage>();

    when(encryptedStorage.store(anything(), anything(), anything())).thenCall(
        (_service: string, key: string, value: string | undefined) => {
            if (value === undefined) {
                secretStorage.delete(key);
            } else {
                secretStorage.set(key, value);
            }

            return Promise.resolve();
        }
    );
    when(encryptedStorage.retrieve(anything(), anything())).thenCall((_service: string, key: string) =>
        Promise.resolve(secretStorage.get(key))
    );

    return instance(encryptedStorage);
}

// getProjectAgentContext still resolves the notebook manager off the static container.
function stubServiceContainerInstance(): ServiceContainer {
    const serviceContainer = mock<ServiceContainer>();

    sinon.stub(ServiceContainer, 'instance').get(() => instance(serviceContainer));

    return serviceContainer;
}

// Mocked WorkspaceEdit.set drops edits — capture on prototype and apply to `cells`.
// `appliedEdits` is local because the shared workspace mock is never reset between tests.
function applyNotebookEditsTo(cells: NotebookCell[], notebook: NotebookDocument) {
    type RecordedEdit = { range: { start: number; end: number }; newCells?: NotebookCellData[] };
    let recordedEdits: RecordedEdit[] = [];
    let appliedEdits = 0;

    sinon.stub(WorkspaceEdit.prototype, 'set').callsFake((_uri, edits) => {
        recordedEdits = edits as unknown as RecordedEdit[];
    });

    when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
        appliedEdits++;

        for (const notebookEdit of recordedEdits) {
            const { start, end } = notebookEdit.range;
            const deleteCount = end - start;
            const newCellData = notebookEdit.newCells;

            if (!newCellData || newCellData.length === 0) {
                if (deleteCount > 0) {
                    cells.splice(start, deleteCount);
                }
                continue;
            }

            const inserted = newCellData.map((cellData) => {
                const created = createMockCell({
                    text: cellData.value,
                    metadata: cellData.metadata
                });
                (created as { notebook: NotebookDocument }).notebook = notebook;

                return created;
            });

            cells.splice(start, deleteCount, ...inserted);
        }
        cells.forEach((cell, index) => ((cell as { index: number }).index = index));
        recordedEdits = [];

        return Promise.resolve(true);
    });

    return { appliedEdits: () => appliedEdits };
}

suite('AgentCellExecutionHandler', () => {
    const secretStorage = new Map<string, string>();
    let disposables: IDisposable[] = [];

    suite('describeExecutionOutputs', () => {
        test('joins nbformat line arrays in stream text', () => {
            const output = {
                output_type: 'stream',
                name: 'stdout',
                text: ['hello\n', 'world\n']
            };

            expect(describeExecutionOutputs([output])).to.equal('hello\nworld\n');
        });

        // String(line[]) joins with commas — breaks DataFrame text/plain for the agent.
        test('joins nbformat line arrays in execute_result and display_data text/plain', () => {
            const executeResult = {
                output_type: 'execute_result',
                data: { 'text/plain': ['   a  b\n', '0  1  4\n', '1  2  5'] },
                metadata: {},
                execution_count: 1
            };
            const displayData = {
                output_type: 'display_data',
                data: { 'text/plain': ['line one\n', 'line two'] },
                metadata: {}
            };

            expect(describeExecutionOutputs([executeResult])).to.equal('   a  b\n0  1  4\n1  2  5');
            expect(describeExecutionOutputs([displayData])).to.equal('line one\nline two');
        });

        test('leaves single-line text/plain untouched', () => {
            const output = {
                output_type: 'execute_result',
                data: { 'text/plain': ['42'] },
                metadata: {},
                execution_count: 1
            };

            expect(describeExecutionOutputs([output])).to.equal('42');
        });

        test('reports no output for an empty output list', () => {
            expect(describeExecutionOutputs([])).to.equal('(no output)');
        });
    });

    suite('executeAgentCell', () => {
        let mockExecution: {
            appendOutput: sinon.SinonStub;
            clearOutput: sinon.SinonStub;
            end: sinon.SinonStub;
            replaceOutput: sinon.SinonStub;
            appendOutputItems: sinon.SinonStub;
            start: sinon.SinonStub;
        };
        let mockController: NotebookController;
        let executeAgentBlockStub: sinon.SinonStub;
        let mockServiceContainer: ServiceContainer;
        let encryptedStorage: IEncryptedStorage;
        let neverCancelled: CancellationToken;

        setup(() => {
            secretStorage.clear();
            secretStorage.set('openAiApiKey', 'test-key');
            encryptedStorage = createEncryptedStorageFake(secretStorage);

            const neverCancelledSource = new CancellationTokenSource();

            neverCancelled = neverCancelledSource.token;
            disposables.push(neverCancelledSource);
            mockServiceContainer = stubServiceContainerInstance();
            disposables.push(new Disposable(() => sinon.restore()));

            mockExecution = {
                appendOutput: sinon.stub().resolves(),
                clearOutput: sinon.stub().resolves(),
                end: sinon.stub(),
                replaceOutput: sinon.stub().resolves(),
                appendOutputItems: sinon.stub().resolves(),
                start: sinon.stub()
            };

            mockController = {
                createNotebookCellExecution: sinon.stub().returns(mockExecution)
            } as unknown as NotebookController;

            executeAgentBlockStub = sinon.stub().resolves({ finalOutput: 'done' });
        });

        teardown(() => {
            disposables = dispose(disposables);
            reset(mockedVSCodeNamespaces.commands);
            // Restore applyEdit default; don't reset() the shared workspace mock.
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(true));
            secretStorage.clear();
        });

        function createAgentCell(text: string = 'Test prompt') {
            return createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text
            });
        }

        function createAgentCellInMutableNotebook(cells: NotebookCell[] = [], agentBlockId = 'agent-block-1') {
            const notebook = createMockNotebook({ cells });
            const agentCell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' }, id: agentBlockId },
                text: 'Test prompt'
            });

            (agentCell as { notebook: typeof notebook }).notebook = notebook;
            (agentCell as { index: number }).index = 0;
            cells.unshift(agentCell);

            applyNotebookEditsTo(cells, notebook);

            return { agentCell, cells, notebook };
        }

        function getStdoutChunkText(callIndex: number): string {
            const item = mockExecution.appendOutputItems.getCall(callIndex).args[0] as NotebookCellOutputItem;

            return Buffer.from(item.data).toString('utf-8');
        }

        test('creates execution, clears output, sets planning output, and ends successfully', async () => {
            const cell = createAgentCell('Analyze data');

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect((mockController.createNotebookCellExecution as sinon.SinonStub).calledOnceWith(cell)).to.be.true;
            expect(mockExecution.start.calledOnce).to.be.true;
            expect(mockExecution.clearOutput.calledOnce).to.be.true;
            expect(mockExecution.clearOutput.calledBefore(mockExecution.replaceOutput)).to.be.true;
            expect(mockExecution.replaceOutput.calledOnce).to.be.true;

            const outputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            expect(outputs).to.have.lengthOf(1);
            expect(outputs[0].items).to.have.lengthOf(1);

            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('[Agent] Planning next steps...');
            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.true;
        });

        // SnapshotService and execute_cell analytics read this shim, not the raw NotebookCellExecution —
        // without these events a Run All containing an agent block never matches its own code-cell count.
        test('reports the run on the execution-state shim so SnapshotService can see it', async () => {
            const cell = createAgentCell('Analyze data');
            const seenStates: NotebookCellExecutionState[] = [];

            disposables.push(
                notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                    if (e.cell === cell) {
                        seenStates.push(e.state);
                    }
                })
            );

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(seenStates).to.deep.equal([NotebookCellExecutionState.Executing, NotebookCellExecutionState.Idle]);
        });

        test('reports Idle on the shim even when the run fails', async () => {
            mockExecution.clearOutput.rejects(new Error('Something went wrong'));

            const cell = createAgentCell();
            const seenStates: NotebookCellExecutionState[] = [];

            disposables.push(
                notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
                    if (e.cell === cell) {
                        seenStates.push(e.state);
                    }
                })
            );

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(seenStates).to.deep.equal([NotebookCellExecutionState.Executing, NotebookCellExecutionState.Idle]);
        });

        // Incremental deltas only — full transcript per event is O(n²) over the EH boundary.
        test('streams text_delta events via appendOutputItems with incremental stdout chunks', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'first' });
                await context.onAgentEvent?.({ type: 'text_delta', text: ' second' });

                return { finalOutput: 'first second' };
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(mockExecution.appendOutputItems.callCount).to.equal(2);

            const item = mockExecution.appendOutputItems.firstCall.args[0] as NotebookCellOutputItem;
            expect(item.mime).to.equal('application/vnd.code.notebook.stdout');
            expect(getStdoutChunkText(0)).to.equal('\n\n[Agent] Text:\nfirst');
            expect(getStdoutChunkText(1)).to.equal(' second');
        });

        test('separates the planning line from the first streamed event', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'reasoning_delta', text: 'Considering the request' });

                return { finalOutput: '' };
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            const seedOutputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            const seed = Buffer.from(seedOutputs[0].items[0].data).toString('utf-8');

            expect(seed + getStdoutChunkText(0)).to.equal(
                '[Agent] Planning next steps...\n\n[Agent] Reasoning:\nConsidering the request'
            );
        });

        test('separates different event types with blank lines', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'thinking...' });
                await context.onAgentEvent?.({ type: 'tool_called', toolName: 'search' });

                return { finalOutput: '' };
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            const chunk2 = getStdoutChunkText(1);
            expect(chunk2).to.include('\n\n');
            expect(chunk2).to.include('[Agent] Tool called: search');
        });

        test('fails execution and writes clearOutput error to stderr', async () => {
            mockExecution.clearOutput.rejects(new Error('Something went wrong'));

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
            expect(mockExecution.appendOutput.calledOnce).to.be.true;

            const outputs = mockExecution.appendOutput.firstCall.args[0] as NotebookCellOutput[];
            expect(outputs).to.have.lengthOf(1);

            const item = outputs[0].items[0];
            expect(item.mime).to.equal('application/vnd.code.notebook.stderr');

            const text = Buffer.from(item.data).toString('utf-8');
            expect(text).to.equal('Something went wrong');
        });

        test('handles empty prompt', async () => {
            const cell = createAgentCell('');

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.true;

            const outputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('[Agent] Planning next steps...');
        });

        test('ends with failure and writes error when API key is not set', async () => {
            secretStorage.clear();
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
            expect(mockExecution.appendOutput.calledOnce).to.be.true;

            const outputs = mockExecution.appendOutput.firstCall.args[0] as NotebookCellOutput[];
            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('OpenAI API key is not set');
        });

        // Caller clears prior ephemeral output; dirty notebook would duplicate agent context.
        test('refuses to run rather than clearing the previous run itself', async () => {
            const previousResult = createMockCell({
                text: 'print("previous run")',
                metadata: { is_ephemeral: true, agent_source_block_id: 'agent-block-1' },
                index: 1
            });
            const { agentCell, cells } = createAgentCellInMutableNotebook([previousResult]);

            await executeAgentCell(agentCell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(executeAgentBlockStub.called).to.be.false;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
            expect(cells).to.include(previousResult);

            const [outputs] = mockExecution.appendOutput.firstCall.args as [NotebookCellOutput[]];
            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('previous run');
        });

        test('inserts ephemeral markdown cells after the agent cell in order', async () => {
            const { agentCell, cells } = createAgentCellInMutableNotebook();

            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.addMarkdownBlock({ content: 'first' });
                await context.addMarkdownBlock({ content: 'second' });

                return { finalOutput: '' };
            });

            await executeAgentCell(agentCell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(cells.map((cell) => cell.document.getText())).to.deep.equal(['Test prompt', 'first', 'second']);
            expect(cells[1].metadata?.is_ephemeral).to.be.true;
            expect(cells[1].metadata?.agent_source_block_id).to.equal(agentCell.metadata?.id);
            expect(cells[2].metadata?.is_ephemeral).to.be.true;
            expect(cells[2].metadata?.agent_source_block_id).to.equal(agentCell.metadata?.id);
        });

        // cellAt clamps — failed insert must not run an existing cell at that index.
        test('fails the tool call without executing anything when the insert edit is rejected', async () => {
            const { agentCell } = createAgentCellInMutableNotebook();
            let toolResult: string | undefined;

            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(false));
            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve();

            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                toolResult = await context.addAndExecuteCodeBlock({ code: 'print(1)' });

                return { finalOutput: '' };
            });

            await executeAgentCell(agentCell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            expect(toolResult).to.include('Execution error');
            expect(toolResult).to.include('Failed to insert ephemeral code cell');
            verify(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).never();
        });

        test('passes project MCP servers and integrations to the agent', async () => {
            const integrations = [{ id: 'warehouse', name: 'Warehouse', type: 'postgres' }];
            const mcpServers = [{ name: 'files', command: 'mcp-files', args: [] }];
            const notebookManager = mock<IDeepnoteNotebookManager>();

            when(mockServiceContainer.tryGet<IDeepnoteNotebookManager>(IDeepnoteNotebookManager)).thenReturn(
                instance(notebookManager)
            );
            when(notebookManager.getProjectForNotebook('project-1', 'notebook-1')).thenReturn(
                createDeepnoteFile({ project: createDeepnoteProject({ integrations, settings: { mcpServers } }) })
            );

            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test prompt',
                notebookMetadata: { deepnoteProjectId: 'project-1', deepnoteNotebookId: 'notebook-1' }
            });

            await executeAgentCell(cell, mockController, encryptedStorage, neverCancelled, {
                executeAgentBlockFn: executeAgentBlockStub
            });

            const context = executeAgentBlockStub.firstCall.args[1] as AgentBlockContext;
            expect(context.mcpServers).to.deep.equal(mcpServers);
            expect(context.integrations).to.deep.equal(integrations);
        });

        suite('cancellation', () => {
            let runTokenSource: CancellationTokenSource;

            setup(() => {
                runTokenSource = new CancellationTokenSource();
                disposables.push(runTokenSource);
            });

            test('refuses to add a generated cell once stopped', async () => {
                const { agentCell, cells } = createAgentCellInMutableNotebook();

                executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                    runTokenSource.cancel();
                    await context.addMarkdownBlock({ content: 'after the stop' });

                    return { finalOutput: '' };
                });

                await executeAgentCell(agentCell, mockController, encryptedStorage, runTokenSource.token, {
                    executeAgentBlockFn: executeAgentBlockStub
                });

                expect(cells.map((cell) => cell.document.getText())).to.deep.equal(['Test prompt']);
            });

            test('stops at the next stream event rather than running to completion', async () => {
                const cell = createAgentCell();
                let eventsAfterStop = 0;

                executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                    runTokenSource.cancel();
                    await context.onAgentEvent?.({ type: 'text_delta', text: 'first' });
                    eventsAfterStop += 1;
                    await context.onAgentEvent?.({ type: 'text_delta', text: 'second' });

                    return { finalOutput: '' };
                });

                await executeAgentCell(cell, mockController, encryptedStorage, runTokenSource.token, {
                    executeAgentBlockFn: executeAgentBlockStub
                });

                expect(eventsAfterStop).to.equal(0);
            });

            test('reports a stop as stopped rather than as a failed run', async () => {
                const cell = createAgentCell();

                executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                    runTokenSource.cancel();
                    await context.onAgentEvent?.({ type: 'text_delta', text: 'first' });

                    return { finalOutput: '' };
                });

                await executeAgentCell(cell, mockController, encryptedStorage, runTokenSource.token, {
                    executeAgentBlockFn: executeAgentBlockStub
                });

                expect(mockExecution.end.firstCall.args[0]).to.be.false;

                const [outputs] = mockExecution.appendOutput.firstCall.args as [NotebookCellOutput[]];
                const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
                expect(text).to.include('Stopped');
                expect(text).to.not.include('Canceled');
            });

            test('a run that is never stopped still completes', async () => {
                const cell = createAgentCell();

                await executeAgentCell(cell, mockController, encryptedStorage, runTokenSource.token, {
                    executeAgentBlockFn: executeAgentBlockStub
                });

                expect(mockExecution.end.firstCall.args[0]).to.be.true;
            });
        });
    });

    suite('removeEphemeralCellsForAgentBlocks', () => {
        teardown(() => {
            sinon.restore();
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(true));
        });

        function createAgentCell(agentBlockId: string) {
            return createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' }, id: agentBlockId },
                text: 'Test prompt'
            });
        }

        function createEphemeralCell(agentBlockId: string, text: string) {
            return createMockCell({
                metadata: { is_ephemeral: true, agent_source_block_id: agentBlockId },
                text
            });
        }

        function createMutableNotebook(cells: NotebookCell[]) {
            const notebook = createMockNotebook({ cells });

            cells.forEach((cell, index) => {
                (cell as { notebook: NotebookDocument }).notebook = notebook;
                (cell as { index: number }).index = index;
            });

            return { notebook, ...applyNotebookEditsTo(cells, notebook) };
        }

        test('drops the previous run from the batch and deletes it from the notebook', async () => {
            const agentCell = createAgentCell('agent-block-1');
            const previousResult = createEphemeralCell('agent-block-1', 'print("previous run")');
            const cells = [agentCell, previousResult];
            const { notebook } = createMutableNotebook(cells);

            const batch = await removeEphemeralCellsForAgentBlocks(notebook, [...cells]);

            expect(batch).to.deep.equal([agentCell]);
            expect(cells).to.deep.equal([agentCell]);
        });

        test('keeps another agent and ordinary cells', async () => {
            const agentCell = createAgentCell('agent-block-1');
            const ownResult = createEphemeralCell('agent-block-1', 'own');
            const otherAgentResult = createEphemeralCell('agent-block-2', 'other agent');
            const userCell = createMockCell({ text: 'user code', metadata: {} });
            const cells = [agentCell, ownResult, otherAgentResult, userCell];
            const { notebook } = createMutableNotebook(cells);

            const batch = await removeEphemeralCellsForAgentBlocks(notebook, [...cells]);

            expect(batch).to.deep.equal([agentCell, otherAgentResult, userCell]);
            expect(cells).to.deep.equal([agentCell, otherAgentResult, userCell]);
        });

        // Generated cell may execute alone via notebook.cell.execute — must stay in batch.
        test('leaves an ephemeral cell whose agent is not in the batch', async () => {
            const agentCell = createAgentCell('agent-block-1');
            const generatedCell = createEphemeralCell('agent-block-1', 'print("just generated")');
            const cells = [agentCell, generatedCell];
            const { notebook, appliedEdits } = createMutableNotebook(cells);

            const batch = await removeEphemeralCellsForAgentBlocks(notebook, [generatedCell]);

            expect(batch).to.deep.equal([generatedCell]);
            expect(cells).to.deep.equal([agentCell, generatedCell]);
            expect(appliedEdits()).to.equal(0);
        });

        test('applies no edit when the batch has no agent cell', async () => {
            const userCell = createMockCell({ text: 'user code', metadata: {} });
            const cells = [userCell];
            const { notebook, appliedEdits } = createMutableNotebook(cells);

            const batch = await removeEphemeralCellsForAgentBlocks(notebook, [...cells]);

            expect(batch).to.deep.equal([userCell]);
            expect(appliedEdits()).to.equal(0);
        });

        // Rejected delete edit must not block running ordinary cells in the batch.
        test('still drops the previous run from the batch when the edit is rejected', async () => {
            const agentCell = createAgentCell('agent-block-1');
            const previousResult = createEphemeralCell('agent-block-1', 'print("previous run")');
            const userCell = createMockCell({ text: 'user code', metadata: {} });
            const cells = [agentCell, previousResult, userCell];
            const { notebook } = createMutableNotebook(cells);

            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(false));

            const batch = await removeEphemeralCellsForAgentBlocks(notebook, [...cells]);

            expect(batch).to.deep.equal([agentCell, userCell]);
            expect(cells).to.deep.equal([agentCell, previousResult, userCell]);
        });
    });

    suite('executeEphemeralCell', () => {
        suite('with active cancellation token', () => {
            let tokenSource: CancellationTokenSource;

            setup(() => {
                tokenSource = new CancellationTokenSource();
            });

            teardown(() => {
                tokenSource.dispose();
                reset(mockedVSCodeNamespaces.commands);
            });

            test('uses current cell index, not stale index from insertion time', async () => {
                const staleIndex = 5;
                const currentIndex = 6;

                const cell = createMockCell({ index: staleIndex });

                (cell as { index: number }).index = currentIndex;

                when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenCall(async () => {
                    notebookCellExecutions.changeCellState(cell, NotebookCellExecutionState.Idle);
                });

                await executeEphemeralCell(cell, tokenSource.token);

                const [commandName, commandArg] = capture(
                    mockedVSCodeNamespaces.commands.executeCommand as (cmd: string, arg: unknown) => Thenable<unknown>
                ).last();

                expect(commandName).to.equal('notebook.cell.execute');
                expect(commandArg).to.deep.equal({
                    ranges: [{ start: currentIndex, end: currentIndex + 1 }],
                    document: cell.notebook.uri
                });
            });

            test('reports the failure reason instead of swallowing it', async () => {
                const cell = createMockCell({ index: 0 });

                when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenReject(
                    new Error('kernel is dead')
                );

                const result = await executeEphemeralCell(cell, tokenSource.token);

                expect(result.success).to.be.false;
                expect(result.error).to.equal('kernel is dead');
            });
        });

        // Pre-cancelled token must skip executeCommand, not only the idle wait.
        suite('with pre-cancelled token', () => {
            let tokenSource: CancellationTokenSource;

            setup(() => {
                tokenSource = new CancellationTokenSource();
                tokenSource.cancel();
            });

            teardown(() => {
                tokenSource.dispose();
                reset(mockedVSCodeNamespaces.commands);
            });

            test('throws without dispatching to the kernel when the token is pre-cancelled', async () => {
                const cell = createMockCell({ index: 0 });

                when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve();

                try {
                    await executeEphemeralCell(cell, tokenSource.token);
                    expect.fail('Should have thrown');
                } catch (e) {
                    expect(e).to.be.instanceOf(CancellationError);
                }

                verify(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).never();
            });
        });

        // Timeout must fire even when executeCommand never resolves.
        suite('with fake timers', () => {
            let clock: sinon.SinonFakeTimers;
            let tokenSource: CancellationTokenSource;

            setup(() => {
                clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                tokenSource = new CancellationTokenSource();
            });

            teardown(() => {
                clock.restore();
                tokenSource.dispose();
                reset(mockedVSCodeNamespaces.commands);
            });

            test('times out while the dispatch is still pending', async () => {
                const cell = createMockCell({ index: 0 });

                when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenCall(
                    () => new Promise(() => undefined)
                );

                const resultPromise = executeEphemeralCell(cell, tokenSource.token);
                await clock.tickAsync(EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS);

                const result = await resultPromise;

                expect(result.success).to.be.false;
                expect(result.error).to.equal('Ephemeral cell execution timed out');
            });
        });
    });
});
