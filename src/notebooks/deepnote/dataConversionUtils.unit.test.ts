import { expect } from 'chai';

import { getBlockId, getEphemeralCellAgentSourceBlockId, isAgentCell } from './dataConversionUtils';
import { createMockCell } from './deepnoteTestHelpers';

suite('DataConversionUtils', () => {
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

    suite('getBlockId', () => {
        test('prefers the backup id VS Code cannot rewrite', () => {
            const cell = createMockCell({ metadata: { __deepnoteBlockId: 'backup-id', id: 'rewritten-id' } });

            expect(getBlockId(cell)).to.equal('backup-id');
        });

        test('falls back to id when the backup is absent', () => {
            const cell = createMockCell({ metadata: { id: 'block-id' } });

            expect(getBlockId(cell)).to.equal('block-id');
        });

        // The fallback-cell path writes this third name. Reading it beats minting a fresh id, which
        // would reassign the block on save.
        test('falls back to the legacy deepnoteBlockId when both are absent', () => {
            const cell = createMockCell({ metadata: { deepnoteBlockId: 'legacy-id' } });

            expect(getBlockId(cell)).to.equal('legacy-id');
        });

        test('ranks the legacy name below both current ones', () => {
            const cell = createMockCell({ metadata: { id: 'block-id', deepnoteBlockId: 'legacy-id' } });

            expect(getBlockId(cell)).to.equal('block-id');
        });

        test('returns undefined for a cell that was never serialized', () => {
            const cell = createMockCell({ metadata: {} });

            expect(getBlockId(cell)).to.be.undefined;
        });
    });

    suite('getEphemeralCellOwner', () => {
        test('returns the agent block that generated the cell', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true, agent_source_block_id: 'agent-block-1' } });

            expect(getEphemeralCellAgentSourceBlockId(cell)).to.equal('agent-block-1');
        });

        // An ordinary cell that happens to carry the metadata is not the agent's to delete.
        test('returns undefined when the cell is not marked ephemeral', () => {
            const cell = createMockCell({ metadata: { agent_source_block_id: 'agent-block-1' } });

            expect(getEphemeralCellAgentSourceBlockId(cell)).to.be.undefined;
        });

        test('returns undefined for an ordinary cell', () => {
            const cell = createMockCell({ metadata: {} });

            expect(getEphemeralCellAgentSourceBlockId(cell)).to.be.undefined;
        });
    });
});
