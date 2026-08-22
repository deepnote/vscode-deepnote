// Unit tests for the federated-auth branch of `CellExecution.execute()`; surrounding VS Code machinery is stubbed and `requestExecute` is captured on a Sinon spy (no socket simulation).

import type { Kernel, KernelMessage } from '@jupyterlab/services';
import type { IKernelConnection } from '@jupyterlab/services/lib/kernel/kernel';
import { assert } from 'chai';
import sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { NotebookCell, NotebookCellKind, Uri } from 'vscode';

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
import { CellExecutionOutputError } from '../errors/cellExecutionOutputError';
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

        controller = createKernelController();
        requestListener = createStubMessageHandler();

        session = mock<IKernelSession>();
        kernel = mock<IKernelConnection>();
        request = mock<Kernel.IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg>>();
        requestDone = createDeferred<KernelMessage.IExecuteReplyMsg>();

        when(request.dispose()).thenReturn();
        when(request.done).thenReturn(requestDone.promise);

        when(session.kernel).thenReturn(instance(kernel));
        when(session.isDisposed).thenReturn(false);
        when(session.kind).thenReturn('localRaw');
        when(session.status).thenReturn('idle');
        when(kernel.isDisposed).thenReturn(false);

        requestExecuteSpy = sinon.spy(
            (_args: KernelMessage.IExecuteRequestMsg['content'], _disposeOnDone: boolean, _metadata: unknown) => {
                return instance(request);
            }
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (when(kernel.requestExecute(anything(), anything(), anything())) as any).thenCall(requestExecuteSpy);
        // Default: main execute resolves immediately. Individual tests can override the deferred before kicking off `start`.
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

    test("generate() is passed the converted block and the executing cell's own notebook URI", async () => {
        // Catches: dropping the URI (or sourcing it from the active editor) — the integration config is resolved
        // per notebook from `.deepnote.env.yaml` merged over SecretStorage, so the wrong notebook resolves wrong.
        const generateStub = sinon.stub().resolves(undefined);
        const generator: IFederatedAuthSqlBlockCodeGenerator = { generate: generateStub };
        const execution = createExecution(generator);

        await execution.start(instance(session));
        await execution.result.catch(() => undefined);

        sinon.assert.calledOnce(generateStub);
        const [block, notebookUri] = generateStub.firstCall.args;
        assert.isObject(block, 'first argument must be the converted Deepnote block');
        assert.strictEqual(notebookUri, cell.notebook.uri);

        // `undefined` from the generator falls back to `createPythonCode` — still exactly one execute.
        const calls = requestExecuteSpy.getCalls();
        assert.strictEqual(calls.length, 1, `expected exactly 1 requestExecute call, got ${calls.length}`);
        assertMainExecuteShape(calls[0]);
    });

    test('when generate() returns a string: exactly one requestExecute with the generated code; token IS present in the execute payload (matches deepnote-internal)', async () => {
        // Mirrors deepnote-internal: a single execute carries the connection JSON (token included) as a Python literal. Cloud history has it; local must match.
        const ACCESS_TOKEN = 'access-token-secret-do-not-log';
        const federatedCode = `_dntk.execute_sql_with_connection_json('SELECT 1', '{"params":{"access_token":"${ACCESS_TOKEN}"}}', audit_sql_comment='', sql_cache_mode='cache_disabled', return_variable_type='dataframe')`;

        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves(federatedCode)
        };
        const execution = createExecution(generator);

        await execution.start(instance(session));
        await execution.result.catch(() => undefined);

        sinon.assert.calledOnce(requestExecuteSpy);
        const [args, dispose] = requestExecuteSpy.getCalls()[0].args;
        const content = args as KernelMessage.IExecuteRequestMsg['content'];
        assert.deepStrictEqual(
            {
                code: content.code,
                silent: content.silent,
                store_history: content.store_history,
                dispose
            },
            { code: federatedCode, silent: false, store_history: true, dispose: false }
        );
        assert.include(
            content.code,
            ACCESS_TOKEN,
            'federated execute payload must carry the access token in the connection-JSON literal (single-call parity with deepnote-internal)'
        );
    });

    test('when generate() returns a string and the execute .done rejects: cell fails with the underlying error', async () => {
        // Catches: regressing the federated branch to swallow execute rejections (or routing them through a second call) would break the standard error surface.
        const federatedCode = `_dntk.execute_sql_with_connection_json('SELECT 1', '{}', audit_sql_comment='', sql_cache_mode='cache_disabled', return_variable_type='dataframe')`;
        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves(federatedCode)
        };
        const execution = createExecution(generator);

        const rejection = new Error('kernel error during execute');
        // Override the default-resolved deferred with a fresh, rejecting one before kicking off start.
        requestDone = createDeferred<KernelMessage.IExecuteReplyMsg>();
        when(request.done).thenReturn(requestDone.promise);
        requestDone.reject(rejection);

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

        sinon.assert.calledOnce(requestExecuteSpy);
        assertMainExecuteShape(requestExecuteSpy.getCalls()[0]);
        assert(caught instanceof Error);
        assert.strictEqual((caught as Error).message, rejection.message);
    });

    test('when generate() returns a string and execute reply has content.status === "error": cell fails with the kernel error', async () => {
        const federatedCode = `_dntk.execute_sql_with_connection_json('SELECT 1', '{}', audit_sql_comment='', sql_cache_mode='cache_disabled', return_variable_type='dataframe')`;
        const generator: IFederatedAuthSqlBlockCodeGenerator = {
            generate: sinon.stub().resolves(federatedCode)
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
        // Replace the default-resolved deferred with one that resolves to an error reply.
        requestDone = createDeferred<KernelMessage.IExecuteReplyMsg>();
        when(request.done).thenReturn(requestDone.promise);
        requestDone.resolve(errorReply);

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

        sinon.assert.calledOnce(requestExecuteSpy);
        assertMainExecuteShape(requestExecuteSpy.getCalls()[0]);
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

            assert(caught instanceof CellExecutionOutputError);
            assert.include(caught.message.toLowerCase(), expectedFragment);
            sinon.assert.notCalled(requestExecuteSpy);
        });
    });
});
