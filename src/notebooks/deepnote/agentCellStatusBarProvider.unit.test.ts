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
            expect(items).to.have.lengthOf(3);
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
                    deepnote_model: 'gpt-4o'
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: gpt-4o');
        });

        test('Should display sonnet model', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_model: 'sonnet'
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[1].text).to.include('Model: sonnet');
        });

        test('Should display "auto" when model is empty string', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_model: ''
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

    suite('Max Iterations', () => {
        test('Should display default max iterations (20) when not set', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
            expect(items[2].text).to.include('$(iterations)');
        });

        test('Should display configured max iterations from metadata', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: 10
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 10');
        });

        test('Should display default when max iterations is not a number', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: 'invalid'
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
        });

        test('Should display default when max iterations is zero', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: 0
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
        });

        test('Should display default when max iterations is a float', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: 5.5
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
        });

        test('Should display default when max iterations is negative', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: -5
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
        });

        test('Should display 1 when max iterations is MIN_ITERATIONS boundary', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: 1
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 1');
        });

        test('Should display 100 when max iterations is at upper bound', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: 100
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 100');
        });

        test('Should display default when max iterations is null', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: null
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
        });

        test('Should display default when max iterations is boolean', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_max_iterations: true
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].text).to.include('Max iterations: 20');
        });

        test('Should have set max iterations command', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].command).to.not.be.undefined;
            const cmd = items[2].command as any;
            expect(cmd.command).to.equal('deepnote.setAgentMaxIterations');
        });

        test('Should have priority 80', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items[2].priority).to.equal(80);
        });
    });

    suite('Combined metadata', () => {
        test('Should display both model and max iterations from metadata', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    deepnote_model: 'gpt-4o',
                    deepnote_max_iterations: 50
                }
            });
            const items = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(items).to.have.lengthOf(3);
            expect(items[0].text).to.include('Agent Block');
            expect(items[1].text).to.include('Model: gpt-4o');
            expect(items[2].text).to.include('Max iterations: 50');
        });
    });
});
