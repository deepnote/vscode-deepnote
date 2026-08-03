import { expect } from 'chai';
import { CancellationToken } from 'vscode';

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
        test('Should display agent block label with icon', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[0].text).to.include('$(hubot)');
            expect(items[0].text).to.include('Agent Block');
            expect(items[0].alignment).to.equal(1);
            expect(items[0].priority).to.equal(100);
        });

        test('Should not have a command on the indicator', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[0].command).to.be.undefined;
        });
    });

    suite('Model Picker', () => {
        test('Should display "auto" when no model is set', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: auto');
            expect(items[1].text).to.include('$(symbol-enum)');
        });

        test('Should display configured model from metadata', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_agent_model: 'gpt-4o'
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: gpt-4o');
        });

        test('Should display gpt-5 model', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_agent_model: 'gpt-5'
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: gpt-5');
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

        test('Should have switch model command', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].command).to.not.be.undefined;
            const cmd = items[1].command as any;
            expect(cmd.command).to.equal('deepnote.switchAgentModel');
        });

        test('Should have priority 90', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].priority).to.equal(90);
        });
    });

    suite('Combined metadata', () => {
        test('Should ignore metadata keys the runtime does not consume', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_agent_model: 'gpt-4o',
                    deepnote_max_iterations: 50
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items).to.have.lengthOf(2);
            expect(items[0].text).to.include('Agent Block');
            expect(items[1].text).to.include('Model: gpt-4o');
        });
    });
});
