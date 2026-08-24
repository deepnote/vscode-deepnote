import { expect } from 'chai';

import { getBlockId, getEphemeralCellAgentSourceBlockId, isAgentCell } from './dataConversionUtils';
import { createMockCell } from './deepnoteTestHelpers';

suite('DataConversionUtils', () => {
    suite('isAgentCell', () => {
        test('returns true for cell with agent pocket type', () => {
            const cell = createMockCell({ metadata: { __deepnotePocket: { type: 'agent' } } });

            expect(isAgentCell(cell)).to.be.true;
        });

        test('returns false for non-agent pocket types', () => {
            const codeCell = createMockCell({ metadata: { __deepnotePocket: { type: 'code' } } });
            const markdownCell = createMockCell({ metadata: { __deepnotePocket: { type: 'markdown' } } });

            expect(isAgentCell(codeCell)).to.be.false;
            expect(isAgentCell(markdownCell)).to.be.false;
        });

        test('returns false when pocket type is not agent', () => {
            const noPocketCell = createMockCell({ metadata: {} });
            const noMetadataCell = createMockCell({ metadata: undefined });

            expect(isAgentCell(noPocketCell)).to.be.false;
            expect(isAgentCell(noMetadataCell)).to.be.false;
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

        // Fallback-cell metadata; minting a new id would reassign the block on save.
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

    suite('getEphemeralCellAgentSourceBlockId', () => {
        test('returns the agent block that generated the cell', () => {
            const cell = createMockCell({ metadata: { is_ephemeral: true, agent_source_block_id: 'agent-block-1' } });

            expect(getEphemeralCellAgentSourceBlockId(cell)).to.equal('agent-block-1');
        });

        // agent_source_block_id alone does not mark a cell for agent cleanup.
        test('returns undefined when the cell is not ephemeral or ordinary', () => {
            const withSourceOnly = createMockCell({ metadata: { agent_source_block_id: 'agent-block-1' } });
            const ordinaryCell = createMockCell({ metadata: {} });

            expect(getEphemeralCellAgentSourceBlockId(withSourceOnly)).to.be.undefined;
            expect(getEphemeralCellAgentSourceBlockId(ordinaryCell)).to.be.undefined;
        });
    });
});
