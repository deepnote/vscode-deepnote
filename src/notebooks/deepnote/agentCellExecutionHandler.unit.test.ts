import { expect } from 'chai';
import * as sinon from 'sinon';
import { NotebookCellOutput, NotebookCellOutputItem, NotebookController } from 'vscode';

import { executeAgentCell, isAgentCell } from './agentCellExecutionHandler';
import { createMockCell } from './deepnoteTestHelpers';

suite('AgentCellExecutionHandler', () => {
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

    suite('executeAgentCell', () => {
        let clock: sinon.SinonFakeTimers;
        let mockExecution: {
            clearOutput: sinon.SinonStub;
            end: sinon.SinonStub;
            replaceOutput: sinon.SinonStub;
            replaceOutputItems: sinon.SinonStub;
            start: sinon.SinonStub;
        };
        let mockController: NotebookController;

        setup(() => {
            clock = sinon.useFakeTimers();

            mockExecution = {
                clearOutput: sinon.stub().resolves(),
                end: sinon.stub(),
                replaceOutput: sinon.stub().resolves(),
                replaceOutputItems: sinon.stub().resolves(),
                start: sinon.stub()
            };

            mockController = {
                createNotebookCellExecution: sinon.stub().returns(mockExecution)
            } as unknown as NotebookController;
        });

        teardown(() => {
            clock.restore();
        });

        async function runToCompletion(promise: Promise<void>): Promise<void> {
            // Total delay across all chunks: 500 + 1000 + 2000 + 3000 = 6500ms
            await clock.tickAsync(7000);
            await promise;
        }

        test('creates execution and starts it', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Analyze data'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect((mockController.createNotebookCellExecution as sinon.SinonStub).calledOnceWith(cell)).to.be.true;
            expect(mockExecution.start.calledOnce).to.be.true;
        });

        test('clears output before streaming', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Analyze data'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.clearOutput.calledOnce).to.be.true;
            expect(mockExecution.clearOutput.calledBefore(mockExecution.replaceOutput)).to.be.true;
        });

        test('sets initial output via replaceOutput', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Hello world'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.replaceOutput.calledOnce).to.be.true;

            const outputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            expect(outputs).to.have.lengthOf(1);
            expect(outputs[0].items).to.have.lengthOf(1);

            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('[Agent] Received prompt (11 chars)');
        });

        test('streams 4 chunks via replaceOutputItems', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test prompt'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.replaceOutputItems.callCount).to.equal(4);
        });

        test('streaming chunks accumulate text progressively', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            const getChunkText = (callIndex: number): string => {
                const item = mockExecution.replaceOutputItems.getCall(callIndex).args[0] as NotebookCellOutputItem;

                return Buffer.from(item.data).toString('utf-8');
            };

            const chunk1 = getChunkText(0);
            const chunk2 = getChunkText(1);
            const chunk3 = getChunkText(2);
            const chunk4 = getChunkText(3);

            expect(chunk1).to.include('Analyzing prompt');
            expect(chunk2).to.include('Generating plan');
            expect(chunk2).to.include('Analyzing prompt');
            expect(chunk3).to.include('Executing steps');
            expect(chunk3).to.include('Generating plan');
            expect(chunk4).to.include('Done');
            expect(chunk4).to.include('Prompt: Test');
        });

        test('streaming chunks fire at correct intervals', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test'
            });

            const promise = executeAgentCell(cell, mockController);

            expect(mockExecution.replaceOutputItems.callCount).to.equal(0);

            await clock.tickAsync(500);
            expect(mockExecution.replaceOutputItems.callCount).to.equal(1);

            await clock.tickAsync(1000);
            expect(mockExecution.replaceOutputItems.callCount).to.equal(2);

            await clock.tickAsync(2000);
            expect(mockExecution.replaceOutputItems.callCount).to.equal(3);

            await clock.tickAsync(3000);
            expect(mockExecution.replaceOutputItems.callCount).to.equal(4);

            await promise;
        });

        test('ends execution with success', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.true;
        });

        test('ends execution with failure when error occurs', async () => {
            mockExecution.clearOutput.rejects(new Error('Test error'));

            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.false;
        });

        test('writes error message to stderr output on failure', async () => {
            mockExecution.clearOutput.rejects(new Error('Something went wrong'));

            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: 'Test'
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.replaceOutput.calledOnce).to.be.true;

            const outputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            expect(outputs).to.have.lengthOf(1);

            const item = outputs[0].items[0];
            expect(item.mime).to.equal('application/vnd.code.notebook.stderr');

            const text = Buffer.from(item.data).toString('utf-8');
            expect(text).to.equal('Something went wrong');
        });

        test('handles empty prompt', async () => {
            const cell = createMockCell({
                metadata: { __deepnotePocket: { type: 'agent' } },
                text: ''
            });

            const promise = executeAgentCell(cell, mockController);
            await runToCompletion(promise);

            expect(mockExecution.end.calledOnce).to.be.true;
            expect(mockExecution.end.firstCall.args[0]).to.be.true;

            const outputs = mockExecution.replaceOutput.firstCall.args[0] as NotebookCellOutput[];
            const text = Buffer.from(outputs[0].items[0].data).toString('utf-8');
            expect(text).to.include('(0 chars)');
        });
    });
});
