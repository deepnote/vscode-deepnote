import { assert } from 'chai';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { CancellationToken, NotebookCell, NotebookCellExecution } from 'vscode';

import { IKernelController } from '../types';
import { CellExecutionCreator, NotebookCellExecutionWrapper } from './cellExecutionCreator';

suite('NotebookCellExecutionWrapper', () => {
    let mockImpl: NotebookCellExecution;
    let mockController: IKernelController;
    let mockCell: NotebookCell;
    let mockToken: CancellationToken;
    let endCallback: () => void;

    setup(() => {
        mockImpl = mock<NotebookCellExecution>();
        mockController = mock<IKernelController>();
        mockCell = mock<NotebookCell>();
        mockToken = mock<CancellationToken>();

        when(mockImpl.cell).thenReturn(instance(mockCell));
        when(mockImpl.token).thenReturn(instance(mockToken));
        when(mockCell.index).thenReturn(0);
        when(mockImpl.start(anything())).thenReturn(undefined);
        when(mockImpl.clearOutput(anything())).thenReturn(Promise.resolve());
        when(mockController.id).thenReturn('test-controller');

        endCallback = () => {
            // noop
        };
    });

    test('When clearOutputOnStartWithTime is true, start is called before clearOutput', () => {
        // Create a manual spy to track call order
        const callOrder: string[] = [];
        const spyImpl = {
            cell: instance(mockCell),
            token: instance(mockToken),
            executionOrder: undefined as number | undefined,
            clearOutput: () => {
                callOrder.push('clearOutput');
                return Promise.resolve();
            },
            start: () => {
                callOrder.push('start');
            },
            end: () => {
                // noop
            },
            replaceOutput: () => Promise.resolve(),
            appendOutput: () => Promise.resolve(),
            replaceOutputItems: () => Promise.resolve(),
            appendOutputItems: () => Promise.resolve()
        } as NotebookCellExecution;

        const wrapper = new NotebookCellExecutionWrapper(spyImpl, 'test-controller', endCallback, true);

        wrapper.start();

        // Verify start was called before clearOutput
        assert.deepStrictEqual(callOrder, ['start', 'clearOutput'], 'start should be called before clearOutput');
    });

    test('When clearOutputOnStartWithTime is false, clearOutput is not called on start', () => {
        const wrapper = new NotebookCellExecutionWrapper(
            instance(mockImpl),
            'test-controller',
            endCallback,
            false // clearOutputOnStartWithTime
        );

        wrapper.start();

        verify(mockImpl.clearOutput(anything())).never();
        verify(mockImpl.start(anything())).once();
    });

    test('When clearOutputOnStartWithTime is true with startTime, start is still called before clearOutput', () => {
        // Create a manual spy to track call order
        const callOrder: string[] = [];
        let capturedStartTime: number | undefined;

        const spyImpl = {
            cell: instance(mockCell),
            token: instance(mockToken),
            executionOrder: undefined as number | undefined,
            clearOutput: () => {
                callOrder.push('clearOutput');
                return Promise.resolve();
            },
            start: (startTime?: number) => {
                callOrder.push('start');
                capturedStartTime = startTime;
            },
            end: () => {
                // noop
            },
            replaceOutput: () => Promise.resolve(),
            appendOutput: () => Promise.resolve(),
            replaceOutputItems: () => Promise.resolve(),
            appendOutputItems: () => Promise.resolve()
        } as NotebookCellExecution;

        const wrapper = new NotebookCellExecutionWrapper(spyImpl, 'test-controller', endCallback, true);

        const startTime = Date.now();
        wrapper.start(startTime);

        // Verify start was called before clearOutput
        assert.deepStrictEqual(
            callOrder,
            ['start', 'clearOutput'],
            'start should be called before clearOutput even with startTime'
        );
        assert.strictEqual(capturedStartTime, startTime, 'startTime should be passed to start()');
    });

    test('start() can be called multiple times but only executes once', () => {
        // Create a manual spy to track call counts
        let clearOutputCallCount = 0;
        let startCallCount = 0;

        const spyImpl = {
            cell: instance(mockCell),
            token: instance(mockToken),
            executionOrder: undefined as number | undefined,
            clearOutput: () => {
                clearOutputCallCount++;
                return Promise.resolve();
            },
            start: () => {
                startCallCount++;
            },
            end: () => {
                // noop
            },
            replaceOutput: () => Promise.resolve(),
            appendOutput: () => Promise.resolve(),
            replaceOutputItems: () => Promise.resolve(),
            appendOutputItems: () => Promise.resolve()
        } as NotebookCellExecution;

        const wrapper = new NotebookCellExecutionWrapper(spyImpl, 'test-controller', endCallback, true);

        wrapper.start();
        wrapper.start();
        wrapper.start();

        // Should only be called once
        assert.strictEqual(clearOutputCallCount, 1, 'clearOutput should be called only once');
        assert.strictEqual(startCallCount, 1, 'start should be called only once');
        assert.isTrue(wrapper.started, 'wrapper should be marked as started');
    });

    test('started flag is false initially and true after start', () => {
        const wrapper = new NotebookCellExecutionWrapper(instance(mockImpl), 'test-controller', endCallback, false);

        assert.isFalse(wrapper.started, 'started should be false before start() is called');

        wrapper.start();

        assert.isTrue(wrapper.started, 'started should be true after start() is called');
    });

    test('clearOutput() is called when reusing a started execution with clearOutputOnStartWithTime=true', () => {
        let clearOutputCallCount = 0;

        const spyImpl = {
            cell: instance(mockCell),
            token: instance(mockToken),
            executionOrder: undefined as number | undefined,
            clearOutput: () => {
                clearOutputCallCount++;
                return Promise.resolve();
            },
            start: () => {
                // noop
            },
            end: () => {
                // noop
            },
            replaceOutput: () => Promise.resolve(),
            appendOutput: () => Promise.resolve(),
            replaceOutputItems: () => Promise.resolve(),
            appendOutputItems: () => Promise.resolve()
        } as NotebookCellExecution;

        const wrapper = new NotebookCellExecutionWrapper(spyImpl, 'test-controller', endCallback, true);

        // Start the wrapper (simulating first execution)
        wrapper.start();

        // Should have called clearOutput once during start
        assert.strictEqual(clearOutputCallCount, 1, 'clearOutput should be called once after start');

        // Now manually call clearOutput to simulate re-execution
        // This simulates what CellExecutionCreator.getOrCreate() does when reusing a started wrapper
        void wrapper.clearOutput();

        // Should have called clearOutput twice now (once from start, once from manual call)
        assert.strictEqual(
            clearOutputCallCount,
            2,
            'clearOutput should be called again when manually invoked on reused wrapper'
        );
    });
});

suite('CellExecutionCreator', () => {
    test('Re-execution: Always creates fresh wrapper and ends old one', () => {
        let endCallCount = 0;
        let clearOutputCallCount = 0;

        // Create mock cell
        const mockCell = mock<NotebookCell>();
        const mockToken = mock<CancellationToken>();
        when(mockCell.index).thenReturn(0);

        // Create a spy implementation to track calls
        const spyImpl1 = {
            cell: instance(mockCell),
            token: instance(mockToken),
            executionOrder: undefined as number | undefined,
            clearOutput: () => {
                clearOutputCallCount++;
                return Promise.resolve();
            },
            start: () => {
                // noop
            },
            end: () => {
                endCallCount++;
            },
            replaceOutput: () => Promise.resolve(),
            appendOutput: () => Promise.resolve(),
            replaceOutputItems: () => Promise.resolve(),
            appendOutputItems: () => Promise.resolve()
        } as NotebookCellExecution;

        const spyImpl2 = {
            cell: instance(mockCell),
            token: instance(mockToken),
            executionOrder: undefined as number | undefined,
            clearOutput: () => {
                clearOutputCallCount++;
                return Promise.resolve();
            },
            start: () => {
                // noop
            },
            end: () => {
                endCallCount++;
            },
            replaceOutput: () => Promise.resolve(),
            appendOutput: () => Promise.resolve(),
            replaceOutputItems: () => Promise.resolve(),
            appendOutputItems: () => Promise.resolve()
        } as NotebookCellExecution;

        // Create mock controller
        const mockController = mock<IKernelController>();
        when(mockController.id).thenReturn('test-controller');
        when(mockController.createNotebookCellExecution(anything())).thenReturn(spyImpl1).thenReturn(spyImpl2);

        // First execution: Create a new execution wrapper
        const execution1 = CellExecutionCreator.getOrCreate(instance(mockCell), instance(mockController), true);
        execution1.start();

        // clearOutput should have been called once during start()
        assert.strictEqual(clearOutputCallCount, 1, 'clearOutput should be called once during first execution start');
        assert.strictEqual(endCallCount, 0, 'end should not be called yet');

        // Simulate re-execution (like what happens when pageSize changes in dataframe)
        // This should end the old wrapper and create a fresh new one
        const execution2 = CellExecutionCreator.getOrCreate(instance(mockCell), instance(mockController), true);

        // Should be a DIFFERENT wrapper instance (fresh one)
        assert.notStrictEqual(execution1, execution2, 'Should create a fresh execution wrapper, not reuse');

        // Old execution should have been ended
        assert.strictEqual(endCallCount, 1, 'Old execution should be ended when creating new one');

        // New execution should be started automatically because old one was started
        assert.isTrue(execution2.started, 'New execution should be started automatically');

        // clearOutput should have been called again during the new execution's start
        assert.strictEqual(clearOutputCallCount, 2, 'clearOutput should be called again when new execution starts');

        // Clean up - end the execution to remove it from the map
        execution2.end(true);
        assert.strictEqual(endCallCount, 2, 'Both executions should be ended');
    });
});
