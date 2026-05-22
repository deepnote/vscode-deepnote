// Unit tests for the federated-auth branch of `CellExecution.execute()`; surrounding VS Code machinery is stubbed and `requestExecute` is captured on a Sinon spy (no socket simulation).

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
    NotAuthenticatedError,
    OAuthClientMisconfiguredError
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

    /** Build a minimal mocked NotebookCell populated for `CellExecution`'s constructor + execute. */
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
        // Stub `CellExecutionMessageHandlerService`: only the main execute is listened to (silent prelude runs first).
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

        // Federated branch: prelude = `requestExecute(args, true)`, main = `requestExecute(args, false, metadata)`. Differentiate by dispose flag.
        requestExecuteSpy = sinon.spy(
            (_args: KernelMessage.IExecuteRequestMsg['content'], disposeOnDone: boolean, _metadata: unknown) => {
                return disposeOnDone ? instance(preludeRequest) : instance(request);
            }
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (when(kernel.requestExecute(anything(), anything(), anything())) as any).thenCall(requestExecuteSpy);
        // Main execute resolves immediately; prelude deferred is left pending so individual tests drive its resolution explicitly.
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

        // Cross-check call order via `calledBefore` for clarity.
        assert.isTrue(
            calls[0].calledBefore(calls[1]),
            'silent prelude requestExecute must be issued before the main requestExecute'
        );
    });

    test('main requestExecute waits for prelude .done before being issued', async () => {
        // Catches: a future change dropping the `await` on prelude `.done` would let the main execute fire before the prelude completes.
        const prelude = `__deepnote_federated_sql_connection__abc = '{}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);
        // Kick off execution without awaiting; if `await preludeDone` is honored, main execute is not issued yet.
        const startPromise = execution.start(instance(session));

        // Flush pending microtasks; I/O is mocked.
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

        // Resolve the prelude — the main `requestExecute` should fire and the cell should complete.
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
        // Catches: dropping the try/catch around `await prelude.done` in `execute()` would either swallow the rejection or let the main execute through.
        const prelude = `__deepnote_federated_sql_connection__abc = '{}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);

        const preludeRejection = new Error('kernel error during prelude');
        // Pre-reject so the implementation observes it on its first await.
        preludeDone.reject(preludeRejection);
        let caught: unknown;
        const startPromise = execution.start(instance(session));
        if (startPromise) {
            await startPromise.catch((err) => {
                caught = err;
            });
        }
        await execution.result.catch(() => undefined);

        // Exactly one `requestExecute` call (prelude); main must NOT be called.
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

        // start() returns the same promise as `result`; await via .catch().
        let caught: unknown;
        const startPromise = execution.start(instance(session));
        if (startPromise) {
            await startPromise.catch((err) => {
                caught = err;
            });
        }
        assert.ok(caught instanceof Error, 'expected the cell to fail');
        // Assert on the user-facing prefix to keep coupling to copy minimal.
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

    test('when generate() throws OAuthClientMisconfiguredError: surfaces the dedicated misconfigured message', async () => {
        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().rejects(new OAuthClientMisconfiguredError('My BigQuery'))
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
        // Asserts on the user-facing language fragment; full copy is owned by `Integrations.federatedAuthOAuthClientMisconfigured`.
        assert.include((caught as Error).message.toLowerCase(), 'misconfigured');
        // Distinct from the generic "not authenticated" path.
        assert.notInclude((caught as Error).message.toLowerCase(), 'not authenticated');

        // Failure happens at code-generation time, so no requestExecute.
        sinon.assert.notCalled(requestExecuteSpy);
    });
});
