import { assert } from 'chai';

import { ExecutionMetadataTracker } from './executionMetadataTracker';

suite('ExecutionMetadataTracker', () => {
    let tracker: ExecutionMetadataTracker;
    const notebookUri = 'file:///path/to/notebook.deepnote';
    const cellId = 'cell-123';

    setup(() => {
        tracker = new ExecutionMetadataTracker();
    });

    suite('recordCellExecutionStart', () => {
        test('records the cell start time and leaves it unfinished', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);

            const metadata = tracker.getBlockExecutionMetadata(notebookUri, cellId);
            assert.isDefined(metadata);
            assert.strictEqual(metadata!.executionStartedAt, new Date(startTime).toISOString());
            assert.isUndefined(metadata!.executionFinishedAt);
        });

        test('does not surface execution metadata until a cell completes', () => {
            tracker.recordCellExecutionStart(notebookUri, cellId, Date.now());

            // No cell has completed, so blocksExecuted is 0 and there is no summary to return.
            assert.isUndefined(tracker.getExecutionMetadata(notebookUri));
        });

        test('re-starting a completed cell clears its finished timestamp', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);
            tracker.recordCellExecutionStart(notebookUri, cellId, startTime + 200);

            const metadata = tracker.getBlockExecutionMetadata(notebookUri, cellId);
            assert.isDefined(metadata);
            assert.isUndefined(metadata!.executionFinishedAt);
        });
    });

    suite('recordCellExecutionEnd', () => {
        test('accumulates success and failure counters and records the error', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
            tracker.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);
            tracker.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
            tracker.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, false, {
                name: 'ValueError',
                message: 'boom'
            });

            const metadata = tracker.getExecutionMetadata(notebookUri);
            assert.isDefined(metadata);
            assert.strictEqual(metadata!.summary!.blocksExecuted, 2);
            assert.strictEqual(metadata!.summary!.blocksSucceeded, 1);
            assert.strictEqual(metadata!.summary!.blocksFailed, 1);
            assert.strictEqual(metadata!.error!.name, 'ValueError');
        });

        test('computes total duration from the session start', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 5000, true);

            const metadata = tracker.getExecutionMetadata(notebookUri);
            assert.strictEqual(metadata!.summary!.totalDurationMs, 5000);
        });

        test('missed-start fallback: counts an end even when no start was recorded', () => {
            const startTime = Date.now();

            // Seed the session (as capture-before-execution would) but never record a start.
            tracker.ensureExecutionState(notebookUri, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);

            const metadata = tracker.getExecutionMetadata(notebookUri);
            assert.isDefined(metadata);
            assert.strictEqual(metadata!.summary!.blocksExecuted, 1);
            assert.strictEqual(metadata!.summary!.blocksSucceeded, 1);
            // No per-cell start was recorded, so there is no block metadata for it.
            assert.isUndefined(tracker.getBlockExecutionMetadata(notebookUri, cellId));
        });

        test('ignores an end for an untracked notebook', () => {
            tracker.recordCellExecutionEnd(notebookUri, cellId, Date.now(), true);

            assert.isUndefined(tracker.getExecutionMetadata(notebookUri));
            assert.isUndefined(tracker.getExecutedBlockCount(notebookUri));
        });

        test('counts a failure with no error object and leaves the summary error undefined', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, false);

            const metadata = tracker.getExecutionMetadata(notebookUri);
            assert.isDefined(metadata);
            assert.strictEqual(metadata!.summary!.blocksFailed, 1);
            assert.strictEqual(metadata!.summary!.blocksSucceeded, 0);
            // A failure reported without an ExecutionError must not synthesize an error field.
            assert.isUndefined(metadata!.error);
        });
    });

    suite('ensureExecutionState', () => {
        test('seeds startedAt from the provided start time', () => {
            const startTime = Date.now();

            tracker.ensureExecutionState(notebookUri, startTime);
            // A completed cell surfaces the summary carrying the seeded startedAt.
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);

            const metadata = tracker.getExecutionMetadata(notebookUri);
            assert.strictEqual(metadata!.startedAt, new Date(startTime).toISOString());
        });

        test('preserves existing state and its startedAt on a later call', () => {
            const firstStart = Date.now();
            const laterStart = firstStart + 10_000;

            tracker.ensureExecutionState(notebookUri, firstStart);
            tracker.recordCellExecutionStart(notebookUri, cellId, firstStart + 50);
            tracker.ensureExecutionState(notebookUri, laterStart);
            tracker.recordCellExecutionEnd(notebookUri, cellId, firstStart + 100, true);

            const metadata = tracker.getExecutionMetadata(notebookUri);
            // startedAt stays at the first seed, not the later ensureExecutionState call.
            assert.strictEqual(metadata!.startedAt, new Date(firstStart).toISOString());
        });
    });

    suite('getExecutedBlockCount', () => {
        test('returns undefined for an untracked notebook', () => {
            assert.isUndefined(tracker.getExecutedBlockCount('file:///unknown.deepnote'));
        });

        test('returns zero for a seeded-but-unexecuted notebook', () => {
            tracker.ensureExecutionState(notebookUri, Date.now());

            assert.strictEqual(tracker.getExecutedBlockCount(notebookUri), 0);
        });

        test('reflects the number of completed cells', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
            tracker.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);
            tracker.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
            tracker.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, true);

            assert.strictEqual(tracker.getExecutedBlockCount(notebookUri), 2);
        });
    });

    suite('hasPendingCellStateChanges', () => {
        test('is true while a started cell has not finished', () => {
            tracker.recordCellExecutionStart(notebookUri, cellId, Date.now());

            assert.isTrue(tracker.hasPendingCellStateChanges(notebookUri));
        });

        test('is false once every started cell finishes', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);

            assert.isFalse(tracker.hasPendingCellStateChanges(notebookUri));
        });

        test('is false for an untracked notebook', () => {
            assert.isFalse(tracker.hasPendingCellStateChanges('file:///unknown.deepnote'));
        });

        test('returns to pending when a finished cell is restarted', () => {
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);
            assert.isFalse(tracker.hasPendingCellStateChanges(notebookUri));

            // Re-running the same cell clears its finished timestamp, so it is pending again.
            tracker.recordCellExecutionStart(notebookUri, cellId, startTime + 200);
            assert.isTrue(tracker.hasPendingCellStateChanges(notebookUri));
        });
    });

    suite('clear', () => {
        test('removes all state for the given notebook only', () => {
            const otherUri = 'file:///other/notebook.deepnote';
            const startTime = Date.now();

            tracker.recordCellExecutionStart(notebookUri, cellId, startTime);
            tracker.recordCellExecutionEnd(notebookUri, cellId, startTime + 100, true);
            tracker.recordCellExecutionStart(otherUri, 'other-cell', startTime);
            tracker.recordCellExecutionEnd(otherUri, 'other-cell', startTime + 100, true);

            tracker.clear(notebookUri);

            assert.isUndefined(tracker.getExecutionMetadata(notebookUri));
            assert.isUndefined(tracker.getExecutedBlockCount(notebookUri));
            assert.isUndefined(tracker.getBlockExecutionMetadata(notebookUri, cellId));

            // The other notebook's state is untouched.
            assert.isDefined(tracker.getExecutionMetadata(otherUri));
        });
    });
});
