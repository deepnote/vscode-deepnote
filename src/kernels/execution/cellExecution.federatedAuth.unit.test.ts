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

function createStubMessageHandler(): CellExecutionMessageHandlerService {
    const stubListener = {
        onErrorHandlingExecuteRequestIOPubMessage: () => ({ dispose: () => undefined }),
        completed: Promise.resolve(),
        dispose: () => undefined
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return {
        registerListenerForExecution: () => stubListener,
        registerListenerForResumingExecution: () => stubListener,
        dispose: () => undefined
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as CellExecutionMessageHandlerService;
}

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
    let connectionMetadata: KernelConnectionMetadata;
    let cell: NotebookCell;

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
        const tokenSource = new CancellationTokenSource();
        disposables.push(tokenSource);

        controller = createKernelController();
        requestListener = createStubMessageHandler();

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

    function assertMainExecuteShape(call: sinon.SinonSpyCall): void {
        const [args, dispose] = call.args;
        const content = args as KernelMessage.IExecuteRequestMsg['content'];
        assert.deepStrictEqual(
            { silent: content.silent, store_history: content.store_history, dispose },
            { silent: false, store_history: true, dispose: false }
        );
    }

    test('when generator is undefined (web): never calls generate, single requestExecute', async () => {
        const execution = createExecution(undefined);
        await execution.start(instance(session));
        await execution.result.catch(() => undefined);

        const calls = requestExecuteSpy.getCalls();
        assert.strictEqual(calls.length, 1, `expected exactly 1 requestExecute call, got ${calls.length}`);
        assertMainExecuteShape(calls[0]);
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
        assertMainExecuteShape(calls[0]);
    });

    test('when generate() returns {prelude, cellCode}: main requestExecute waits for prelude .done, omits the access token', async () => {
        // Catches: dropping the `await` on prelude `.done` would let the main execute fire before the prelude completes,
        // and leaking the access token into `cellCode` would let it surface in execution-history JSON.
        const ACCESS_TOKEN = 'access-token-secret-do-not-log';
        const prelude = `__deepnote_federated_sql_connection__abc = '{"params":{"access_token":"${ACCESS_TOKEN}"}}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);

        // Kick off without awaiting; the main execute must NOT issue while prelude is unresolved.
        const startPromise = execution.start(instance(session));

        // Flush pending microtasks; I/O is mocked.
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }

        sinon.assert.calledOnce(requestExecuteSpy);
        const [preludeArgs, preludeDispose] = requestExecuteSpy.getCalls()[0].args;
        const preludeContent = preludeArgs as KernelMessage.IExecuteRequestMsg['content'];
        assert.deepStrictEqual(
            {
                code: preludeContent.code,
                silent: preludeContent.silent,
                store_history: preludeContent.store_history,
                allow_stdin: preludeContent.allow_stdin,
                stop_on_error: preludeContent.stop_on_error,
                dispose: preludeDispose
            },
            {
                code: prelude,
                silent: true,
                store_history: false,
                allow_stdin: false,
                stop_on_error: true,
                dispose: true
            }
        );

        // Resolve the prelude — the main `requestExecute` should fire and the cell should complete.
        preludeDone.resolve(successReply);
        if (startPromise) {
            await startPromise.catch(() => undefined);
        }
        await execution.result.catch(() => undefined);

        sinon.assert.calledTwice(requestExecuteSpy);
        const [mainArgs, mainDispose] = requestExecuteSpy.getCalls()[1].args;
        const mainContent = mainArgs as KernelMessage.IExecuteRequestMsg['content'];
        assert.deepStrictEqual(
            {
                code: mainContent.code,
                silent: mainContent.silent,
                store_history: mainContent.store_history,
                dispose: mainDispose
            },
            { code: cellCode, silent: false, store_history: true, dispose: false }
        );

        // Critical M3 invariant: the access token must not appear in the main execute's code.
        assert.isFalse(
            mainContent.code.includes(ACCESS_TOKEN),
            `Main execute code unexpectedly contains the access token: ${mainContent.code}`
        );
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
        assert.deepStrictEqual(
            {
                silent: (preludeArgs as KernelMessage.IExecuteRequestMsg['content']).silent,
                dispose: preludeDispose
            },
            { silent: true, dispose: true },
            'the single call should be the silent prelude'
        );

        // The cell-execution failure should surface the underlying error.
        assert(caught instanceof Error);
        assert.strictEqual(caught.message, preludeRejection.message);
    });

    test('when prelude reply has content.status === "error": main requestExecute is NOT called and cell fails with the kernel error', async () => {
        // Catches: prelude reply with status='error' was previously ignored; main execute would then NameError on the unset global.
        const prelude = `__deepnote_federated_sql_connection__abc = '{}'`;
        const cellCode = `_dntk.execute_sql_with_connection_json('SELECT 1', __deepnote_federated_sql_connection__abc)`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves({ prelude, cellCode })
        };
        const execution = createExecution(generator);

        const errorReply: KernelMessage.IExecuteReplyMsg = {
            ...successReply,
            content: {
                execution_count: 1,
                status: 'error',
                ename: 'NameError',
                evalue: 'name "x" is not defined',
                traceback: ['line1']
            }
        };
        preludeDone.resolve(errorReply);

        let caught: unknown;
        const startPromise = execution.start(instance(session));
        if (startPromise) {
            await startPromise.catch((err) => {
                caught = err;
            });
        }
        await execution.result.catch((err) => {
            if (!caught) {
                caught = err;
            }
        });

        // Exactly one `requestExecute` call (prelude); main must NOT be called.
        assert.strictEqual(
            requestExecuteSpy.callCount,
            1,
            `expected exactly 1 requestExecute call, got ${requestExecuteSpy.callCount}`
        );

        assert(caught instanceof Error);
        const message = (caught as Error).message;
        assert.isTrue(
            message.includes('NameError') || message.includes('name "x" is not defined'),
            `expected error message to include "NameError" or 'name "x" is not defined', got: ${message}`
        );
    });

    (
        [
            ['NotAuthenticatedError', () => new NotAuthenticatedError('My BigQuery'), 'not authenticated'],
            ['OAuthClientMisconfiguredError', () => new OAuthClientMisconfiguredError('My BigQuery'), 'misconfigured']
        ] as const
    ).forEach(([label, buildError, expectedFragment]) => {
        test(`when generate() throws ${label}: cell fails with the typed message and main requestExecute is NOT called`, async () => {
            const generator: IFederatedAuthSqlBlockCodeGenerator = {
                generate: sinon.stub().rejects(buildError())
            };
            const execution = createExecution(generator);

            let caught: unknown;
            const startPromise = execution.start(instance(session));
            if (startPromise) {
                await startPromise.catch((err) => {
                    caught = err;
                });
            }

            assert(caught instanceof Error);
            assert.include(caught.message.toLowerCase(), expectedFragment);
            sinon.assert.notCalled(requestExecuteSpy);
        });
    });
});
