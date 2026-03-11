import { expect } from 'chai';
import { CancellationToken } from 'vscode';

import { EphemeralCellStatusBarProvider } from './ephemeralCellStatusBarProvider';
import { createMockCell } from './deepnoteTestHelpers';

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
        test('Should return a status bar item for ephemeral cell', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.not.be.undefined;
        });

        test('Should return undefined when is_ephemeral is false', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: false } });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.be.undefined;
        });

        test('Should return undefined when is_ephemeral is not set', () => {
            const cell = createMockCell({ metadata: {} });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.be.undefined;
        });

        test('Should return undefined for cell without metadata', () => {
            const cell = createMockCell({ metadata: undefined });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.be.undefined;
        });

        test('Should return undefined when is_ephemeral is a non-boolean truthy value', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: 'true' } });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.be.undefined;
        });

        test('Should return undefined when cancellation is requested', () => {
            const cancelledToken: CancellationToken = {
                isCancellationRequested: true,
                onCancellationRequested: () => ({ dispose: () => undefined })
            } as any;
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, cancelledToken);

            expect(item).to.be.undefined;
        });
    });

    suite('Status Bar Item Properties', () => {
        test('Should display sparkle icon with Ephemeral label', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.text).to.include('$(sparkle)');
            expect(item.text).to.include('Ephemeral');
        });

        test('Should have left alignment', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.alignment).to.equal(1);
        });

        test('Should have priority 1000 to appear before all other items', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.priority).to.equal(1000);
        });

        test('Should not have a command', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.command).to.be.undefined;
        });
    });

    suite('Tooltip', () => {
        test('Should include auto-generated description in tooltip', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.tooltip).to.include('Auto-generated ephemeral block');
        });

        test('Should include agent source block ID in tooltip when present', () => {
            const cell = createMockCell({
                metadata: {
                    is_ephemeral: true,
                    agent_source_block_id: 'a0000000000000000000000000000004'
                }
            });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.tooltip).to.include('a0000000000000000000000000000004');
            expect(item.tooltip).to.include('Source agent block');
        });

        test('Should not include source block line in tooltip when agent_source_block_id is absent', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.tooltip).to.not.include('Source agent block');
        });
    });

    suite('Coexistence with other cell types', () => {
        test('Should return item for ephemeral agent cell', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'agent' },
                    is_ephemeral: true,
                    agent_source_block_id: 'source-id'
                }
            });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.not.be.undefined;
        });

        test('Should return item for ephemeral code cell', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'code' },
                    is_ephemeral: true
                }
            });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.not.be.undefined;
        });

        test('Should return item for ephemeral markdown cell', () => {
            const cell = createMockCell({
                metadata: {
                    __deepnotePocket: { type: 'markdown' },
                    is_ephemeral: true
                }
            });
            const item = provider.provideCellStatusBarItems(cell, mockToken);

            expect(item).to.not.be.undefined;
        });
    });
});
