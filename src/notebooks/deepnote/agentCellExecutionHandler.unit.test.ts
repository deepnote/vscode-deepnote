import { expect } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, reset, when } from 'ts-mockito';
import {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    ExtensionMode,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookController,
    SecretStorage,
    SecretStorageChangeEvent
} from 'vscode';

import type { AgentBlock } from '@deepnote/blocks';
import type { AgentBlockContext, AgentBlockResult } from '@deepnote/runtime-core';

import type { IDisposable } from '../../platform/common/types';
import { IExtensionContext } from '../../platform/common/types';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { dispose } from '../../platform/common/utils/lifecycle';
import { mockedVSCodeNamespaces } from '../../test/vscode-mock';
import { ServiceContainer } from '../../platform/ioc/container';
import { executeAgentCell, executeEphemeralCell, getOpenAiApiKey, isAgentCell } from './agentCellExecutionHandler';
import { createMockCell } from './deepnoteTestHelpers';

suite('AgentCellExecutionHandler', () => {
    const secretStorage = new Map<string, string>();
    let disposables: IDisposable[] = [];

    suite('isAgentCell', () => {
        test('returns true for cell with agent pocket type', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });

            expect(isAgentCell(cell)).to.be.true;
        });

        test('returns false for cell with code pocket type', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'code' } } });

            expect(isAgentCell(cell)).to.be.false;
        });

        test('returns false for cell with markdown pocket type', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'markdown' } } });

            expect(isAgentCell(cell)).to.be.false;
        });

        test('returns false for cell without pocket', () => {
            const cell = createMockCell({ metadata: {} });

            expect(isAgentCell(cell)).to.be.false;
        });

        test('returns false for cell without metadata', () => {
            const cell = createMockCell({ metadata: undefined });

            expect(isAgentCell(cell)).to.be.false;
        });
    });

    suite('getOpenAiApiKey', () => {
        setup(() => {
            secretStorage.clear();
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
            disposables.push(new Disposable(() => sinon.restore()));
        });

        teardown(() => {
            disposables = dispose(disposables);
        });

        test('returns key when configured', async () => {
            secretStorage.set('openAiApiKey', 'test-key');

            const key = await getOpenAiApiKey();

            expect(key).to.equal('test-key');
        });

        test('throws when key is not set', async () => {
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            try {
                await getOpenAiApiKey();
                expect.fail('Should have thrown');
            } catch (e) {
                expect((e as Error).message).to.include('OpenAI API key is not set');
            }
        });
    });

    suite('executeAgentCell', () => {
        let mockExecution: {
            appendOutput: sinon.SinonStub;
            clearOutput: sinon.SinonStub;
            end: sinon.SinonStub;
            replaceOutput: sinon.SinonStub;
            replaceOutputItems: sinon.SinonStub;
            start: sinon.SinonStub;
        };
        let mockController: NotebookController;
        let executeAgentBlockStub: sinon.SinonStub;

        setup(() => {
            secretStorage.clear();
            secretStorage.set('openAiApiKey', 'test-key');
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
            disposables.push(new Disposable(() => sinon.restore()));

            mockExecution = {
                appendOutput: sinon.stub().resolves(),
                clearOutput: sinon.stub().resolves(),
                end: sinon.stub(),
                replaceOutput: sinon.stub().resolves(),
                replaceOutputItems: sinon.stub().resolves(),
                start: sinon.stub()
            };

            mockController = {
                createNotebookCellExecution: sinon.stub().returns(mockExecution)
            } as unknown as NotebookController;

            executeAgentBlockStub = sinon.stub().resolves({ finalOutput: 'done' } as AgentBlockResult);
        });

        teardown(() => {
            disposables = dispose(disposables);
        });

        function createAgentCell(text: string = 'Test prompt') {
            return createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text
            });
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

        test('streams events via replaceOutputItems using onAgentEvent callback', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'Hello ' });
                await context.onAgentEvent?.({ type: 'text_delta', text: 'world' });

                return { finalOutput: 'Hello world' } as AgentBlockResult;
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            expect(mockExecution.replaceOutputItems.callCount).to.equal(2);
        });

        test('streaming chunks accumulate text progressively', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'first' });
                await context.onAgentEvent?.({ type: 'text_delta', text: ' second' });

                return { finalOutput: 'first second' } as AgentBlockResult;
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            const getChunkText = (callIndex: number): string => {
                const item = mockExecution.replaceOutputItems.getCall(callIndex).args[0] as NotebookCellOutputItem;

                return Buffer.from(item.data).toString('utf-8');
            };

            const chunk1 = getChunkText(0);
            const chunk2 = getChunkText(1);

            expect(chunk1).to.include('[Agent] Text:');
            expect(chunk1).to.include('first');
            expect(chunk2).to.include('first second');
        });

        test('separates different event types with blank lines', async () => {
            executeAgentBlockStub.callsFake(async (_block: AgentBlock, context: AgentBlockContext) => {
                await context.onAgentEvent?.({ type: 'text_delta', text: 'thinking...' });
                await context.onAgentEvent?.({ type: 'tool_called', toolName: 'search' });

                return { finalOutput: '' } as AgentBlockResult;
            });

            const cell = createAgentCell();

            await executeAgentCell(cell, mockController, { executeAgentBlockFn: executeAgentBlockStub });

            const getChunkText = (callIndex: number): string => {
                const item = mockExecution.replaceOutputItems.getCall(callIndex).args[0] as NotebookCellOutputItem;

                return Buffer.from(item.data).toString('utf-8');
            };

            const chunk2 = getChunkText(1);
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

        test('returns success false immediately when token is pre-cancelled', async () => {
            const cell = createMockCell({ index: 0 });
            const tokenSource = new CancellationTokenSource();
            tokenSource.cancel();

            when(mockedVSCodeNamespaces.commands.executeCommand(anything(), anything())).thenResolve();

            try {
                const result = await executeEphemeralCell(cell, tokenSource.token);

                expect(result).to.deep.equal({
                    success: false,
                    outputs: [],
                    executionCount: null
                });
            } finally {
                tokenSource.dispose();
            }
        });
    });
});
