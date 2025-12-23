import { assert } from 'chai';
import { instance, mock } from 'ts-mockito';

import { SnapshotMetadataService } from './snapshotMetadataService';
import { IEnvironmentCapture } from './environmentCapture.node';
import { IDisposableRegistry } from '../../platform/common/types';

suite('SnapshotMetadataService', () => {
    let service: SnapshotMetadataService;
    let mockEnvironmentCapture: IEnvironmentCapture;
    let mockDisposables: IDisposableRegistry;

    const notebookUri = 'file:///path/to/notebook.deepnote';
    const cellId = 'cell-123';

    setup(() => {
        mockEnvironmentCapture = mock<IEnvironmentCapture>();
        mockDisposables = [];

        service = new SnapshotMetadataService(instance(mockEnvironmentCapture), mockDisposables);
    });

    suite('recordCellExecutionStart', () => {
        test('should record cell execution start time', () => {
            const startTime = Date.now();

            service.recordCellExecutionStart(notebookUri, cellId, startTime);

            const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
            assert.isDefined(metadata);
            assert.isDefined(metadata!.executionStartedAt);
            assert.isUndefined(metadata!.executionFinishedAt);
        });

        test('should initialize notebook execution state', () => {
            const startTime = Date.now();

            service.recordCellExecutionStart(notebookUri, cellId, startTime);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            // Should not have execution metadata yet since no cells have completed
            assert.isUndefined(executionMetadata);
        });

        test('should handle multiple cells in same notebook', () => {
            const startTime = Date.now();

            service.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
            service.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 1000);

            const metadata1 = service.getBlockExecutionMetadata(notebookUri, 'cell-1');
            const metadata2 = service.getBlockExecutionMetadata(notebookUri, 'cell-2');

            assert.isDefined(metadata1);
            assert.isDefined(metadata2);
            assert.notStrictEqual(metadata1!.executionStartedAt, metadata2!.executionStartedAt);
        });
    });

    suite('recordCellExecutionEnd', () => {
        test('should record successful cell execution end', () => {
            const startTime = Date.now();
            const endTime = startTime + 1000;

            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

            const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
            assert.isDefined(metadata);
            assert.isDefined(metadata!.executionStartedAt);
            assert.isDefined(metadata!.executionFinishedAt);
        });

        test('should update execution summary on success', () => {
            const startTime = Date.now();
            const endTime = startTime + 1000;

            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            assert.isDefined(executionMetadata);
            assert.isDefined(executionMetadata!.summary);
            assert.strictEqual(executionMetadata!.summary!.blocksExecuted, 1);
            assert.strictEqual(executionMetadata!.summary!.blocksSucceeded, 1);
            assert.strictEqual(executionMetadata!.summary!.blocksFailed, 0);
        });

        test('should update execution summary on failure', () => {
            const startTime = Date.now();
            const endTime = startTime + 1000;

            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, endTime, false);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            assert.isDefined(executionMetadata);
            assert.isDefined(executionMetadata!.summary);
            assert.strictEqual(executionMetadata!.summary!.blocksExecuted, 1);
            assert.strictEqual(executionMetadata!.summary!.blocksSucceeded, 0);
            assert.strictEqual(executionMetadata!.summary!.blocksFailed, 1);
        });

        test('should record error details on failure', () => {
            const startTime = Date.now();
            const endTime = startTime + 1000;
            const error = { name: 'TypeError', message: 'undefined is not a function' };

            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, endTime, false, error);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            assert.isDefined(executionMetadata);
            assert.isDefined(executionMetadata!.error);
            assert.strictEqual(executionMetadata!.error!.name, 'TypeError');
            assert.strictEqual(executionMetadata!.error!.message, 'undefined is not a function');
        });

        test('should accumulate multiple cell executions', () => {
            const startTime = Date.now();

            // Execute 3 cells: 2 successful, 1 failed
            service.recordCellExecutionStart(notebookUri, 'cell-1', startTime);
            service.recordCellExecutionEnd(notebookUri, 'cell-1', startTime + 100, true);

            service.recordCellExecutionStart(notebookUri, 'cell-2', startTime + 200);
            service.recordCellExecutionEnd(notebookUri, 'cell-2', startTime + 300, true);

            service.recordCellExecutionStart(notebookUri, 'cell-3', startTime + 400);
            service.recordCellExecutionEnd(notebookUri, 'cell-3', startTime + 500, false);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            assert.isDefined(executionMetadata);
            assert.isDefined(executionMetadata!.summary);
            assert.strictEqual(executionMetadata!.summary!.blocksExecuted, 3);
            assert.strictEqual(executionMetadata!.summary!.blocksSucceeded, 2);
            assert.strictEqual(executionMetadata!.summary!.blocksFailed, 1);
        });

        test('should calculate total duration', () => {
            const startTime = Date.now();
            const endTime = startTime + 5000;

            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, endTime, true);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            assert.isDefined(executionMetadata);
            assert.isDefined(executionMetadata!.summary);
            assert.strictEqual(executionMetadata!.summary!.totalDurationMs, 5000);
        });
    });

    suite('getExecutionMetadata', () => {
        test('should return undefined for unknown notebook', () => {
            const metadata = service.getExecutionMetadata('unknown-notebook');
            assert.isUndefined(metadata);
        });

        test('should return undefined if no cells have been executed', () => {
            const startTime = Date.now();
            service.recordCellExecutionStart(notebookUri, cellId, startTime);

            const metadata = service.getExecutionMetadata(notebookUri);
            assert.isUndefined(metadata);
        });

        test('should include ISO timestamps', () => {
            const startTime = Date.now();
            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

            const metadata = service.getExecutionMetadata(notebookUri);
            assert.isDefined(metadata);
            assert.isDefined(metadata!.startedAt);
            assert.isDefined(metadata!.finishedAt);
            // Should be valid ISO date strings
            assert.doesNotThrow(() => new Date(metadata!.startedAt!));
            assert.doesNotThrow(() => new Date(metadata!.finishedAt!));
        });
    });

    suite('getBlockExecutionMetadata', () => {
        test('should return undefined for unknown notebook', () => {
            const metadata = service.getBlockExecutionMetadata('unknown-notebook', cellId);
            assert.isUndefined(metadata);
        });

        test('should return undefined for unknown cell', () => {
            const startTime = Date.now();
            service.recordCellExecutionStart(notebookUri, cellId, startTime);

            const metadata = service.getBlockExecutionMetadata(notebookUri, 'unknown-cell');
            assert.isUndefined(metadata);
        });
    });

    suite('updateContentHash', () => {
        test('should update content hash for existing cell', () => {
            const startTime = Date.now();
            service.recordCellExecutionStart(notebookUri, cellId, startTime);

            service.updateContentHash(notebookUri, cellId, 'sha256:abc123');

            const metadata = service.getBlockExecutionMetadata(notebookUri, cellId);
            assert.isDefined(metadata);
            assert.strictEqual(metadata!.contentHash, 'sha256:abc123');
        });

        test('should not fail for unknown notebook', () => {
            // Should not throw
            service.updateContentHash('unknown-notebook', cellId, 'md5:abc123');
        });
    });

    suite('clearExecutionState', () => {
        test('should clear all state for a notebook', () => {
            const startTime = Date.now();
            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

            service.clearExecutionState(notebookUri);

            const executionMetadata = service.getExecutionMetadata(notebookUri);
            const blockMetadata = service.getBlockExecutionMetadata(notebookUri, cellId);

            assert.isUndefined(executionMetadata);
            assert.isUndefined(blockMetadata);
        });

        test('should only clear state for specified notebook', () => {
            const startTime = Date.now();
            const otherNotebookUri = 'file:///other/notebook.deepnote';

            service.recordCellExecutionStart(notebookUri, cellId, startTime);
            service.recordCellExecutionEnd(notebookUri, cellId, startTime + 1000, true);

            service.recordCellExecutionStart(otherNotebookUri, 'other-cell', startTime);
            service.recordCellExecutionEnd(otherNotebookUri, 'other-cell', startTime + 1000, true);

            service.clearExecutionState(notebookUri);

            // First notebook should be cleared
            assert.isUndefined(service.getExecutionMetadata(notebookUri));

            // Second notebook should still have state
            assert.isDefined(service.getExecutionMetadata(otherNotebookUri));
        });
    });

    suite('multiple notebooks', () => {
        test('should track state independently for different notebooks', () => {
            const notebook1 = 'file:///notebook1.deepnote';
            const notebook2 = 'file:///notebook2.deepnote';
            const startTime = Date.now();

            // Execute cells in different notebooks
            service.recordCellExecutionStart(notebook1, 'cell-1', startTime);
            service.recordCellExecutionEnd(notebook1, 'cell-1', startTime + 100, true);

            service.recordCellExecutionStart(notebook2, 'cell-2', startTime);
            service.recordCellExecutionEnd(notebook2, 'cell-2', startTime + 200, false);

            const metadata1 = service.getExecutionMetadata(notebook1);
            const metadata2 = service.getExecutionMetadata(notebook2);

            assert.isDefined(metadata1);
            assert.isDefined(metadata1!.summary);
            assert.strictEqual(metadata1!.summary!.blocksSucceeded, 1);
            assert.strictEqual(metadata1!.summary!.blocksFailed, 0);

            assert.isDefined(metadata2);
            assert.isDefined(metadata2!.summary);
            assert.strictEqual(metadata2!.summary!.blocksSucceeded, 0);
            assert.strictEqual(metadata2!.summary!.blocksFailed, 1);
        });
    });
});
