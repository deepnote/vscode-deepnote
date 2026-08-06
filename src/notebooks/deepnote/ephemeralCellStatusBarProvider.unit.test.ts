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
        test('Should set ephemeral status bar item properties', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.text).to.include('$(sparkle)');
            expect(item.text).to.include('Ephemeral');
            expect(item.alignment).to.equal(1);
            expect(item.priority).to.equal(1000);
            expect(item.command).to.be.undefined;
        });
    });

    suite('Tooltip', () => {
        test('Should describe ephemeral tooltip without source block when agent_source_block_id is absent', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true } });
            const item = provider.provideCellStatusBarItems(cell, mockToken)!;

            expect(item.tooltip).to.include('Auto-generated ephemeral block');
            expect(item.tooltip).to.not.include('Source agent block');
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
    });

    suite('Coexistence with other cell types', () => {
        test('Should return item for ephemeral cells regardless of pocket type', () => {
            const pocketTypes = ['agent', 'code', 'markdown'] as const;

            for (const type of pocketTypes) {
                const cell = createMockCell({
                    metadata: {
                        __deepnotePocket: { type },
                        is_ephemeral: true,
                        ...(type === 'agent' ? { agent_source_block_id: 'source-id' } : {})
                    }
                });
                const item = provider.provideCellStatusBarItems(cell, mockToken);

                expect(item).to.not.be.undefined;
            }
        });
    });
});
