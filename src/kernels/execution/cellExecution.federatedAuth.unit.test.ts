// Unit tests for the federated-auth branch of `CellExecution.execute()`.
//
// The full `CellExecution` orchestration depends on a number of VS Code
// globals (`workspace.onDidCloseTextDocument`, the kernel controller's
// `createNotebookCellExecution`, etc.). These tests focus exclusively on
// the federated branch and stub the surrounding machinery just enough to
// drive `start()` to completion. Deviation from existing test patterns:
// no `fakeKernelConnection.node`-style end-to-end socket simulation —
// instead we capture `requestExecute` calls on a Sinon stub. Documented
// in the test file header so the next agent knows the shape.

import type { Kernel, KernelMessage } from '@jupyterlab/services';
import type { IKernelConnection } from '@jupyterlab/services/lib/kernel/kernel';
import { assert } from 'chai';
import sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { NotebookCell, NotebookCellKind, Uri } from 'vscode';

import { CancellationTokenSource } from 'vscode';
import { dispose } from '../../platform/common/utils/lifecycle';
import { createDeferred, Deferred } from '../../platform/common/utils/async';
import { IDisposable } from '../../platform/common/types';
import {
    IFederatedAuthSqlBlockCodeGenerator,
    NotAuthenticatedError
} from '../../notebooks/deepnote/integrations/types';
import { IKernelController, IKernelSession, KernelConnectionMetadata } from '../types';
import { createKernelController } from '../../test/datascience/notebook/executionHelper';
import { CellExecution, CellExecutionFactory } from './cellExecution';
import { CellExecutionMessageHandlerService } from './cellExecutionMessageHandlerService';

suite('CellExecution federated-auth branch', () => {
    let disposables: IDisposable[] = [];
    let controller: IKernelController;
    let requestListener: CellExecutionMessageHandlerService;
    let session: IKernelSession;
    let kernel: IKernelConnection;
    let request: Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg>;
    let requestDone: Deferred<KernelMessage.IExecuteReplyMsg>;
    let preludeRequest: Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg>;
    let preludeDone: Deferred<KernelMessage.IExecuteReplyMsg>;
    let requestExecuteSpy: sinon.SinonSpy;
    let tokenSource: CancellationTokenSource;
    let connectionMetadata: KernelConnectionMetadata;
    let cell: NotebookCell;

    const successReply: KernelMessage.IExecuteReplyMsg = {
        channel: 'shell',
        content: {
            execution_count: 1,
            status: 'ok',
            user_expressions: {}
        },
        header: {
            msg_id: '1',
            msg_type: 'execute_reply',
            session: '1',
            username: '1',
            date: new Date().toString(),
            version: '5.0'
        } as KernelMessage.IExecuteReplyMsg['header'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parent_header: {} as any
    };

    /**
     * Construct a minimal mocked NotebookCell whose `index`, `document`,
     * `notebook`, `kind`, `metadata`, and `outputs` are all populated.
     * `CellExecution`'s constructor + execute method touch all of these.
     */
    function buildCell(opts: {
        content: string;
        languageId?: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata?: Record<string, any>;
    }): NotebookCell {
        const document = {
            getText: () => opts.content,
            languageId: opts.languageId ?? 'sql',
            isClosed: false,
            uri: Uri.parse(`untitled:test-cell-${Math.random()}.py`)
        };
        const notebook = {
            isClosed: false,
            uri: Uri.parse('untitled:test-notebook.deepnote')
        };
        return {
            index: 0,
            kind: NotebookCellKind.Code,
            document,
            notebook,
            metadata: opts.metadata ?? {},
            outputs: [],
            executionSummary: undefined
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any as NotebookCell;
    }

    setup(() => {
        disposables = [];
        tokenSource = new CancellationTokenSource();
        disposables.push(tokenSource);

        controller = createKernelController();
        // Minimal stub of CellExecutionMessageHandlerService — the
        // federated branch issues its silent pre-execute *before* the
        // main `requestExecute`, so the listener is only registered for
        // the main execute (which we let succeed without messages).
        requestListener = {
            registerListenerForExecution: () =>
                ({
                    onErrorHandlingExecuteRequestIOPubMessage: () => ({ dispose: () => undefined }),
                    completed: Promise.resolve(),
                    dispose: () => undefined
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }) as any,
            registerListenerForResumingExecution: () =>
                ({
                    onErrorHandlingExecuteRequestIOPubMessage: () => ({ dispose: () => undefined }),
                    completed: Promise.resolve(),
                    dispose: () => undefined
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }) as any,
            dispose: () => undefined
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any as CellExecutionMessageHandlerService;

        session = mock<IKernelSession>();
        kernel = mock<IKernelConnection>();
        request = mock<Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg>>();
        preludeRequest = mock<Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg>>();
        requestDone = createDeferred<KernelMessage.IExecuteReplyMsg>();
        preludeDone = createDeferred<KernelMessage.IExecuteReplyMsg>();

        when(request.dispose()).thenReturn();
        when(request.done).thenReturn(requestDone.promise);
        when(preludeRequest.dispose()).thenReturn();
        when(preludeRequest.done).thenReturn(preludeDone.promise);

        when(session.kernel).thenReturn(instance(kernel));
        when(session.isDisposed).thenReturn(false);
        when(session.kind).thenReturn('localRaw');
        when(session.status).thenReturn('idle');
        when(kernel.isDisposed).thenReturn(false);

        // The federated branch invokes `requestExecute(args, true, undefined)` (dispose=true) for
        // the silent prelude; the main execute is `requestExecute(args, false, metadata)`.
        // Differentiate by the 2nd positional argument so order can be asserted.
        requestExecuteSpy = sinon.spy(
            (_args: KernelMessage.IExecuteRequestMsg['content'], disposeOnDone: boolean, _metadata: unknown) => {
                return disposeOnDone ? instance(preludeRequest) : instance(request);
            }
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (when(kernel.requestExecute(anything(), anything(), anything())) as any).thenCall(requestExecuteSpy);
        // Allow the *main* execute to complete immediately so `result`
        // resolves; the *prelude* deferred is intentionally left pending
        // here so individual tests can drive its resolution (or rejection)
        // explicitly. This is what lets us detect a missing `await` on the
        // prelude `.done` — see "main requestExecute waits for prelude .done"
        // below.
        requestDone.resolve(successReply);

        connectionMetadata = {
            id: 'test-kernel',
            kind: 'startUsingLocalKernelSpec',
            interpreter: undefined
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any as KernelConnectionMetadata;

        cell = buildCell({ content: 'SELECT 1', languageId: 'sql' });
    });

    teardown(() => {
        disposables = dispose(disposables);
    });

    function createExecution(generator?: IFederatedAuthSqlBlockCodeGenerator) {
        const factory = new CellExecutionFactory(controller, requestListener, generator);
        const execution = factory.create(cell, undefined, connectionMetadata) as CellExecution;
        disposables.push(execution);
        return execution;
    }

    test('when generator is undefined (web): never calls generate, single requestExecute', async () => {
        const execution = createExecution(undefined);
        await execution.start(instance(session));
        await execution.result.catch(() => undefined);

        // Exactly one requestExecute call (the main one with store_history: true).
        const calls = requestExecuteSpy.getCalls();
        assert.strictEqual(calls.length, 1, `expected exactly 1 requestExecute call, got ${calls.length}`);
        const [args, dispose] = calls[0].args;
        assert.strictEqual((args as KernelMessage.IExecuteRequestMsg['content']).silent, false);
        assert.strictEqual((args as KernelMessage.IExecuteRequestMsg['content']).store_history, true);
        assert.strictEqual(dispose, false);
    });

    test('when generate() returns undefined: no silent pre-execute, single main requestExecute', async () => {
        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves(undefined)
        };
        const execution = createExecution(generator);
        await execution.start(instance(session));
        await execution.result.catch(() => undefined);

        sinon.assert.calledOnce(generator.generate as sinon.SinonStub);
        const calls = requestExecuteSpy.getCalls();
        assert.strictEqual(calls.length, 1, `expected exactly 1 requestExecute call, got ${calls.length}`);
        const [args, dispose] = calls[0].args;
        assert.strictEqual((args as KernelMessage.IExecuteRequestMsg['content']).silent, false);
        assert.strictEqual((args as KernelMessage.IExecuteRequestMsg['content']).store_history, true);
        assert.strictEqual(dispose, false);
    });

    test('when generate() returns {prelude, cellCode}: silent prelude first, then main execute', async () => {
        const ACCESS_TOKEN = 'access-token-secret-do-not-log';
        const prelude = `__deepnote_federated_sql_connection__abc = '{"params":{"access_token":"${ACCESS_TOKEN}"}}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);
        // Resolve the prelude so the `await` on its `.done` returns
        // (otherwise `execution.result` would hang).
        preludeDone.resolve(successReply);
        await execution.start(instance(session));
        await execution.result.catch(() => undefined);

        sinon.assert.calledOnce(generator.generate as sinon.SinonStub);

        // Exactly two requestExecute calls.
        const calls = requestExecuteSpy.getCalls();
        assert.strictEqual(calls.length, 2, `expected 2 requestExecute calls, got ${calls.length}`);

        // First call: silent prelude.
        const [preludeArgs, preludeDispose] = calls[0].args;
        const preludeContent = preludeArgs as KernelMessage.IExecuteRequestMsg['content'];
        assert.strictEqual(preludeContent.code, prelude);
        assert.strictEqual(preludeContent.silent, true);
        assert.strictEqual(preludeContent.store_history, false);
        assert.strictEqual(preludeContent.allow_stdin, false);
        assert.strictEqual(preludeContent.stop_on_error, true);
        assert.strictEqual(preludeDispose, true);

        // Second call: main execute.
        const [mainArgs, mainDispose] = calls[1].args;
        const mainContent = mainArgs as KernelMessage.IExecuteRequestMsg['content'];
        assert.strictEqual(mainContent.code, cellCode);
        assert.strictEqual(mainContent.silent, false);
        assert.strictEqual(mainContent.store_history, true);
        assert.strictEqual(mainDispose, false);

        // Critical M3 invariant: the access token must not appear in the main execute's code.
        assert.isFalse(
            mainContent.code.includes(ACCESS_TOKEN),
            `Main execute code unexpectedly contains the access token: ${mainContent.code}`
        );

        // Call order: the prelude is at index 0 and the main call is at
        // index 1. Sinon records calls in the order they were invoked,
        // so the array index alone proves the order. Cross-check via
        // `calledBefore` to be explicit.
        assert.isTrue(
            calls[0].calledBefore(calls[1]),
            'silent prelude requestExecute must be issued before the main requestExecute'
        );
    });

    test('main requestExecute waits for prelude .done before being issued', async () => {
        // Regression guard for the `await` on the prelude `.done` in
        // `cellExecution.execute`. If a future change drops the `await`,
        // the main `requestExecute` would be issued synchronously after
        // the prelude `requestExecute`, before the prelude has actually
        // completed. To detect that, this test leaves `preludeDone`
        // pending, ticks the microtask queue exhaustively, and asserts
        // only the prelude has been issued. Then it resolves
        // `preludeDone` and asserts the main call lands.
        const prelude = `__deepnote_federated_sql_connection__abc = '{}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);
        // Kick off execution without awaiting; if the `await` on
        // `preludeDone` is honored, the main `requestExecute` will not be
        // issued yet.
        const startPromise = execution.start(instance(session));

        // Flush pending microtasks by yielding multiple times.
        // Anything that the implementation queues synchronously /
        // microtask-only will have run by now. Real I/O is mocked, so
        // there is nothing else competing for the event loop.
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }

        sinon.assert.calledOnce(requestExecuteSpy);
        const [preludeArgs, preludeDispose] = requestExecuteSpy.getCalls()[0].args;
        assert.strictEqual(
            (preludeArgs as KernelMessage.IExecuteRequestMsg['content']).silent,
            true,
            'first call should be the silent prelude'
        );
        assert.strictEqual(preludeDispose, true, 'first call should dispose-on-done (prelude convention)');

        // Now resolve the prelude — the main `requestExecute` should be
        // issued and the cell should complete.
        preludeDone.resolve(successReply);
        if (startPromise) {
            await startPromise.catch(() => undefined);
        }
        await execution.result.catch(() => undefined);

        sinon.assert.calledTwice(requestExecuteSpy);
        const [mainArgs, mainDispose] = requestExecuteSpy.getCalls()[1].args;
        const mainContent = mainArgs as KernelMessage.IExecuteRequestMsg['content'];
        assert.strictEqual(mainContent.code, cellCode);
        assert.strictEqual(mainContent.silent, false);
        assert.strictEqual(mainContent.store_history, true);
        assert.strictEqual(mainDispose, false);
    });

    test('when prelude requestExecute rejects: main requestExecute is NOT called and cell fails', async () => {
        // Hard invariant from the plan: a kernel rejection of the silent
        // prelude must block the main `requestExecute` from being issued.
        // The `try/catch` around `await kernelConnection.requestExecute(...).done`
        // in `execute()` is what enforces this — without the `await` or
        // with a missing `catch`, the rejected promise would either fire
        // unhandled or let the main execute through.
        const prelude = `__deepnote_federated_sql_connection__abc = '{}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);

        const preludeRejection = new Error('kernel error during prelude');
        // Reject the prelude before kicking off execution so the
        // implementation observes the rejection on its first await.
        preludeDone.reject(preludeRejection);
        let caught: unknown;
        const startPromise = execution.start(instance(session));
        if (startPromise) {
            await startPromise.catch((err) => {
                caught = err;
            });
        }
        await execution.result.catch(() => undefined);

        // Exactly one `requestExecute` call — the prelude. The main
        // execute must NOT have been called.
        sinon.assert.calledOnce(requestExecuteSpy);
        const [preludeArgs, preludeDispose] = requestExecuteSpy.getCalls()[0].args;
        assert.strictEqual(
            (preludeArgs as KernelMessage.IExecuteRequestMsg['content']).silent,
            true,
            'the single call should be the silent prelude'
        );
        assert.strictEqual(preludeDispose, true);

        // The cell-execution failure should surface the underlying error.
        assert.ok(caught instanceof Error, 'expected the cell to fail');
        assert.strictEqual((caught as Error).message, preludeRejection.message);
    });

    test('when generate() throws NotAuthenticatedError: cell fails, main requestExecute is NOT called', async () => {
        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().rejects(new NotAuthenticatedError('My BigQuery'))
        };
        const execution = createExecution(generator);

        // start() returns the same promise as `result`; await it via .catch()
        // since the failure path rejects.
        let caught: unknown;
        const startPromise = execution.start(instance(session));
        if (startPromise) {
            await startPromise.catch((err) => {
                caught = err;
            });
        }
        assert.ok(caught instanceof Error, 'expected the cell to fail');
        // Hardcoded English string per M3 (M4 wires l10n). Assert on the
        // user-facing prefix, not the full message, to avoid coupling
        // tests to copy.
        assert.include((caught as Error).message, 'not authenticated');

        // No requestExecute should have been issued.
        sinon.assert.notCalled(requestExecuteSpy);
    });

    test('when generate() throws a generic error: cell fails, main requestExecute is NOT called', async () => {
        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().rejects(new Error('Some other error'))
        };
        const execution = createExecution(generator);

        let caught: unknown;
        const startPromise = execution.start(instance(session));
        if (startPromise) {
            await startPromise.catch((err) => {
                caught = err;
            });
        }
        assert.ok(caught instanceof Error, 'expected the cell to fail');

        // No requestExecute should have been issued.
        sinon.assert.notCalled(requestExecuteSpy);
    });
});
