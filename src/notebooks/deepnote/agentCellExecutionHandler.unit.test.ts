import { expect } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, reset, verify, when } from 'ts-mockito';
import {
    CancellationError,
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    ExtensionMode,
    NotebookCell,
    NotebookCellData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookController,
    NotebookDocument,
    SecretStorage,
    SecretStorageChangeEvent,
    Uri,
    WorkspaceEdit
} from 'vscode';

import type { AgentBlock } from '@deepnote/blocks';
import type { AgentBlockContext, AgentBlockResult } from '@deepnote/runtime-core';

import type { IDisposable } from '../../platform/common/types';
import { IExtensionContext } from '../../platform/common/types';
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

/**
 * Wires up a ServiceContainer whose IExtensionContext exposes an in-memory SecretStorage, so the
 * secret-store helpers take their real code paths instead of the ExtensionMode.Test no-op branch.
 */
function stubSecretStorage(secretStorage: Map<string, string>): ServiceContainer {
    const context = mock<IExtensionContext>();
    const secrets = mock<SecretStorage>();
    const onDidChangeSecrets = new EventEmitter<SecretStorageChangeEvent>();
    const serviceContainer = mock<ServiceContainer>();

    sinon.stub(ServiceContainer, 'instance').get(() => instance(serviceContainer));
    when(serviceContainer.get<IExtensionContext>(IExtensionContext)).thenReturn(instance(context));
    when(context.extensionMode).thenReturn(ExtensionMode.Production);
    when(context.secrets).thenReturn(instance(secrets));
    when(secrets.onDidChange).thenReturn(onDidChangeSecrets.event);
    when(secrets.get(anything())).thenCall((key: string) => Promise.resolve(secretStorage.get(key)));
    when(secrets.store(anything(), anything())).thenCall((key: string, value: string) => {
        secretStorage.set(key, value);

        return Promise.resolve();
    });

    return serviceContainer;
}

/**
 * Makes `workspace.applyEdit` apply the notebook edits it is given to `cells`, so the code under test
 * observes its own inserts and deletes.
 *
 * The mocked `WorkspaceEdit.set` discards the edits it is given, so record them off the prototype
 * rather than reading them back off the edit object.
 *
 * Returns the number of edits applied so far — the shared `workspace` mock is never reset between
 * tests, so its own call counts are useless here.
 */
function applyNotebookEditsTo(cells: NotebookCell[], notebook: NotebookDocument) {
    type RecordedEdit = { range: { start: number; end: number }; newCells: NotebookCellData[] };
    let recordedEdits: RecordedEdit[] = [];
    let appliedEdits = 0;

    sinon.stub(WorkspaceEdit.prototype, 'set').callsFake((_uri, edits) => {
        recordedEdits = edits as unknown as RecordedEdit[];
    });

    when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => {
        appliedEdits++;

        for (const notebookEdit of recordedEdits) {
            const { start, end } = notebookEdit.range;
            const inserted = notebookEdit.newCells.map((cellData) => {
                const created = createMockCell({
                    text: cellData.value,
                    metadata: cellData.metadata
                });
                (created as { notebook: NotebookDocument }).notebook = notebook;

                return created;
            });

            cells.splice(start, end - start, ...inserted);
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

        // translateCellDisplayOutput splits `text/plain` into a line array, and @deepnote/blocks
        // stringifies it with String(...) — which joins with commas. Without the fix the agent reads
        // its own DataFrame output with a comma glued to the start of every line but the first.
        test('joins nbformat line arrays in execute_result text/plain', () => {
            const output = {
                output_type: 'execute_result',
                data: { 'text/plain': ['   a  b\n', '0  1  4\n', '1  2  5'] },
                metadata: {},
                execution_count: 1
            };

            expect(describeExecutionOutputs([output])).to.equal('   a  b\n0  1  4\n1  2  5');
        });

        test('joins nbformat line arrays in display_data text/plain', () => {
            const output = {
                output_type: 'display_data',
                data: { 'text/plain': ['line one\n', 'line two'] },
                metadata: {}
            };

            expect(describeExecutionOutputs([output])).to.equal('line one\nline two');
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

        setup(() => {
            secretStorage.clear();
            secretStorage.set('openAiApiKey', 'test-key');
            mockServiceContainer = stubSecretStorage(secretStorage);
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

            executeAgentBlockStub = sinon.stub().resolves({ finalOutput: 'done' } as AgentBlockResult);
        });

        teardown(() => {
            disposables = dispose(disposables);
            reset(mockedVSCodeNamespaces.commands);
            // Restore the default from vscode-mock rather than reset()ing the whole workspace
            // namespace, which other suites rely on.
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(true));
        });

        function createAgentCell(text: string = 'Test prompt') {
            return createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text
            });
        }

        /**
         * Builds an agent cell inside a notebook whose cell list the test can mutate, and applies
         * insert/delete notebook edits to that list so the handler observes its own mutations.
         */
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

        test('creates execution and starts it', async () => {
            const cell = createAgentCell('Analyze data');

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect((mockController.createNotebookCellExecution as sinon.SinonStub).calledOnceWith(cell)).to.be.true;
            expect(mockExecution.start.calledOnce).to.be.true;
        });

        test('clears output before streaming', async () => {
            const cell = createAgentCell('Analyze data');

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.clearOutput.calledOnce).to.be.true;
            expect(mockExecution.clearOutput.calledBefore(mockExecution.replaceOutput)).to.be.true;
        });

        test('sets initial output via replaceOutput', async () => {
            const cell = createAgentCell('Hello world');

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.replaceOutput.calledOnce).to.be.true;

            const outputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            expect(outputs).to.have.lengthOf(1);
            expect(outputs[0].items).to.have.lengthOf(1);

            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('[Agent] Planning next steps...');
        });

        test('streams events via appendOutputItems using onAgentEvent callback', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'Hello ' });
                await context.onAgentEvent?.({ type: 'text_delta', text: 'world' });

                return { finalOutput: 'Hello world' } as AgentBlockResult;
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.appendOutputItems.callCount).to.equal(2);

            const item = mockExecution.appendOutputItems.firstCall.args[0] as NotebookCellOutputItem;
            expect(item.mime).to.equal('application/vnd.code.notebook.stdout');
        });

        // Each event must ship only its own delta: re-sending the whole transcript per token is
        // O(n²) bytes over the extension-host boundary, and runtime-core awaits this callback.
        test('streaming sends only the incremental text per event', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'first' });
                await context.onAgentEvent?.({ type: 'text_delta', text: ' second' });

                return { finalOutput: 'first second' } as AgentBlockResult;
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(getStdoutChunkText(0)).to.equal('[Agent] Text:\nfirst');
            expect(getStdoutChunkText(1)).to.equal(' second');
        });

        test('separates different event types with blank lines', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'thinking...' });
                await context.onAgentEvent?.({ type: 'tool_called', toolName: 'search' });

                return { finalOutput: '' } as AgentBlockResult;
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            const chunk2 = getStdoutChunkText(1);
            expect(chunk2).to.include('\n\n');
            expect(chunk2).to.include('[Agent] Tool called: search');
        });

        test('ends execution with success', async () => {
            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.true;
        });

        test('ends execution with failure when error occurs', async () => {
            mockExecution.clearOutput.rejects(new Error('Test error'));

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
        });

        test('writes error message to stderr output on failure', async () => {
            mockExecution.clearOutput.rejects(new Error('Something went wrong'));

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

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

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

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

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
            expect(mockExecution.appendOutput.calledOnce).to.be.true;

            const outputs = mockExecution.appendOutput.firstCall.args[0] as NotebookCellOutput[];
            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('OpenAI API key is not set');
        });

        // Clearing the previous run belongs to the caller. Running against a dirty notebook fails
        // silently — the agent gets its own old output as context and appends a second copy below it
        // — so the precondition is checked rather than assumed.
        test('refuses to run rather than clearing the previous run itself', async () => {
            const previousResult = createMockCell({
                text: 'print("previous run")',
                metadata: { is_ephemeral: true, agent_source_block_id: 'agent-block-1' },
                index: 1
            });
            const { agentCell, cells } = createAgentCellInMutableNotebook([previousResult]);

            await executeAgentCell(agentCell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(executeAgentBlockStub.called).to.be.false;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
            expect(cells).to.include(previousResult);

            const [outputs] = mockExecution.appendOutput.firstCall.args as [NotebookCellOutput[]];
            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('previous run');
        });

        test('inserts a markdown cell after the agent cell with ephemeral metadata', async () => {
            const { agentCell, cells } = createAgentCellInMutableNotebook();

            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.addMarkdownBlock({ content: '## Findings' });

                return { finalOutput: '' } as AgentBlockResult;
            });

            await executeAgentCell(agentCell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(cells).to.have.lengthOf(2);
            expect(cells[1].document.getText()).to.equal('## Findings');
            expect(cells[1].metadata?.is_ephemeral).to.be.true;
            expect(cells[1].metadata?.agent_source_block_id).to.equal(agentCell.metadata?.id);
        });

        test('inserts successive cells after the ones it already added', async () => {
            const { agentCell, cells } = createAgentCellInMutableNotebook();

            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.addMarkdownBlock({ content: 'first' });
                await context.addMarkdownBlock({ content: 'second' });

                return { finalOutput: '' } as AgentBlockResult;
            });

            await executeAgentCell(agentCell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(cells.map((cell) => cell.document.getText())).to.deep.equal(['Test prompt', 'first', 'second']);
        });

        // cellAt clamps rather than throwing, so resolving the inserted cell by index would hand the
        // agent a pre-existing user cell and execute it.
        test('fails the tool call without executing anything when the insert edit is rejected', async () => {
            const { agentCell } = createAgentCellInMutableNotebook();
            let toolResult: string | undefined;

            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenCall(() => Promise.resolve(false));
            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve();

            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                toolResult = await context.addAndExecuteCodeBlock({ code: 'print(1)' });

                return { finalOutput: '' } as AgentBlockResult;
            });

            await executeAgentCell(agentCell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

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

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            const context = executeAgentBlockStub.firstCall.args[1] as AgentBlockContext;
            expect(context.mcpServers).to.deep.equal(mcpServers);
            expect(context.integrations).to.deep.equal(integrations);
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

        /** Wires the cells into a notebook whose list the applied edits actually mutate. */
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

        // An agent runs the code cell it just generated through `notebook.cell.execute`, which arrives
        // here as a batch of that cell alone. Dropping it would hang the agent until its timeout.
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

        // The agent cells re-check the notebook and report it on the cell, so a rejected edit must not
        // hold back the batch's ordinary code cells.
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
        teardown(() => {
            reset(mockedVSCodeNamespaces.commands);
        });

        test('uses current cell index, not stale index from insertion time', async () => {
            const staleIndex = 5;
            const currentIndex = 6;

            const cell = createMockCell({ index: staleIndex });

            // Simulate a concurrent insertion shifting the cell's index
            (cell as { index: number }).index = currentIndex;

            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenCall(async () => {
                notebookCellExecutions.changeCellState(cell, NotebookCellExecutionState.Idle);
            });

            await executeEphemeralCell(cell);

            const [commandName, commandArg] = capture(
                mockedVSCodeNamespaces.commands.executeCommand as (cmd: string, arg: unknown) => Thenable<unknown>
            ).last();

            expect(commandName).to.equal('notebook.cell.execute');
            expect(commandArg).to.deep.equal({
                ranges: [{ start: currentIndex, end: currentIndex + 1 }],
                document: cell.notebook.uri
            });
        });

        // Rejecting the deferred alone abandons only the wait — the generated code would still reach
        // the kernel after the user cancelled.
        test('throws without dispatching to the kernel when the token is pre-cancelled', async () => {
            const cell = createMockCell({ index: 0 });
            const tokenSource = new CancellationTokenSource();
            tokenSource.cancel();

            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve();

            try {
                await executeEphemeralCell(cell, tokenSource.token);
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(CancellationError);
            } finally {
                tokenSource.dispose();
            }

            verify(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).never();
        });

        test('reports the failure reason instead of swallowing it', async () => {
            const cell = createMockCell({ index: 0 });

            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenReject(
                new Error('kernel is dead')
            );

            const result = await executeEphemeralCell(cell);

            expect(result.success).to.be.false;
            expect(result.error).to.equal('kernel is dead');
        });

        // The dispatch settles independently of the cell reaching Idle, so waiting on it first would
        // leave the timeout unable to end a run whose command never resolves.
        test('times out while the dispatch is still pending', async () => {
            const cell = createMockCell({ index: 0 });
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

            try {
                when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenCall(
                    () => new Promise(() => undefined)
                );

                const resultPromise = executeEphemeralCell(cell);
                await clock.tickAsync(EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS);

                const result = await resultPromise;

                expect(result.success).to.be.false;
                expect(result.error).to.equal('Ephemeral cell execution timed out');
            } finally {
                clock.restore();
            }
        });
    });
});

suite('createMockNotebook', () => {
    test('reads through to the backing cell array', () => {
        const cells: NotebookCell[] = [createMockCell({ text: 'first' })];
        const notebook = createMockNotebook({ cells, uri: Uri.file('/test/mutable.deepnote') });

        expect(notebook.cellCount).to.equal(1);

        cells.push(createMockCell({ text: 'second', index: 1 }));

        expect(notebook.cellCount).to.equal(2);
        expect(notebook.cellAt(1).document.getText()).to.equal('second');
        expect(notebook.getCells()).to.have.lengthOf(2);
    });
});
