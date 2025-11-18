import { assert } from 'chai';
import { Signal } from '@lumino/signaling';
import * as sinon from 'sinon';
import * as fakeTimers from '@sinonjs/fake-timers';
import { Kernel, type KernelMessage } from '@jupyterlab/services';
import { generateUuid } from '../../platform/common/uuid';
import { anything, instance, mock, reset, verify, when } from 'ts-mockito';
import {
    IKernel,
    IKernelProvider,
    IKernelSession,
    LocalKernelSpecConnectionMetadata,
    PythonKernelConnectionMetadata
} from '../../kernels/types';
import { createMockedDocument } from '../../test/datascience/editor-integration/helpers';
import {
    CancellationToken,
    CancellationTokenSource,
    CompletionItem,
    Disposable,
    Position,
    Range,
    TextDocument,
    Uri,
    type MarkdownString
} from 'vscode';
import { IDisposable, IDisposableRegistry } from '../../platform/common/types';
import { DisposableStore, dispose } from '../../platform/common/utils/lifecycle';
import { type Deferred, createDeferred } from '../../platform/common/utils/async';
import { IInspectReplyMsg } from '@jupyterlab/services/lib/kernel/messages';
import { sleep } from '../../test/core';
import { ServiceContainer } from '../../platform/ioc/container';
import { PythonExtension } from '@vscode/python-extension';
import { setPythonApi } from '../../platform/interpreter/helpers';
import { IControllerRegistration } from '../../notebooks/controllers/types';
import esmock from 'esmock';

suite('Jupyter Kernel Completion (requestInspect)', () => {
    let kernel: IKernel;
    let kernelId = '';
    let kernelConnection: Kernel.IKernelConnection;
    let document: TextDocument;
    let completionItem: CompletionItem;
    let token: CancellationToken;
    let tokenSource: CancellationTokenSource;
    let disposables: IDisposable[] = [];
    let toDispose: DisposableStore;
    let clock: fakeTimers.InstalledClock;
    let resolveCompletionItem: any;
    let maxPendingKernelRequests: number;
    let execCodeInBackgroundThreadStub: sinon.SinonStub;

    const pythonKernel = PythonKernelConnectionMetadata.create({
        id: 'pythonId',
        interpreter: {
            id: 'pythonId',
            uri: Uri.file('python')
        },
        kernelSpec: {
            argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
            display_name: 'Python 3',
            executable: 'python',
            name: 'python3'
        }
    });
    const nonPythonKernel = LocalKernelSpecConnectionMetadata.create({
        id: 'java',
        kernelSpec: {
            argv: ['java'],
            display_name: 'Java',
            executable: 'java',
            name: 'java'
        }
    });
    let kernelStatusChangedSignal: Signal<Kernel.IKernelConnection, Kernel.Status>;

    // Mock ServiceContainer instance
    let serviceContainerInstance: any;
    const ServiceContainerMock = class {
        static get instance() {
            return serviceContainerInstance;
        }
    };

    setup(async () => {
        kernelConnection = mock<Kernel.IKernelConnection>();
        kernel = mock<IKernel>();
        kernelId = generateUuid();
        when(kernel.id).thenReturn(kernelId);
        when(kernel.kernelConnectionMetadata).thenReturn(instance(pythonKernel));
        const session = mock<IKernelSession>();
        when(kernel.session).thenReturn(instance(session));
        when(session.kernel).thenReturn(instance(kernelConnection));
        kernelStatusChangedSignal = new Signal<Kernel.IKernelConnection, Kernel.Status>(instance(kernelConnection));
        when(kernelConnection.statusChanged).thenReturn(kernelStatusChangedSignal);
        disposables.push(new Disposable(() => Signal.disconnectAll(kernelStatusChangedSignal)));
        document = createMockedDocument('foo.', Uri.parse('a.ipynb'), 1, true);

        tokenSource = new CancellationTokenSource();
        token = tokenSource.token;
        toDispose = new DisposableStore();

        clock = fakeTimers.install();

        disposables.push(new Disposable(() => clock.uninstall()));
        disposables.push(new Disposable(() => Signal.disconnectAll(instance(kernelConnection))));
        disposables.push(tokenSource);
        disposables.push(toDispose);

        execCodeInBackgroundThreadStub = sinon.stub();
        // Load module with esmock
        const module = await esmock('./resolveCompletionItem', {
            '../../platform/ioc/container': {
                ServiceContainer: ServiceContainerMock
            },
            '@vscode/python-extension': {
                PythonExtension: {
                    api: () => Promise.resolve(undefined) // Default mock
                }
            },
            '../../platform/common/utils/async': {
                createDeferred,
                sleep,
                raceTimeoutError: (timeout: number, error: Error, ...promises: Promise<any>[]) => {
                    let promiseReject: ((value: unknown) => void) | undefined = undefined;
                    const timer = setTimeout(() => promiseReject?.(error), timeout);

                    return Promise.race([
                        Promise.race(promises).finally(() => clearTimeout(timer)),
                        new Promise<any>((_, reject) => (promiseReject = reject))
                    ]);
                }
            },
            '../../platform/common/cancellation': {
                raceCancellation: (_token: CancellationToken, promise: Promise<any>) => promise,
                wrapCancellationTokens: (token: CancellationToken) => ({
                    token,
                    cancel: () => {},
                    dispose: () => {}
                })
            },
            '../api/kernels/backgroundExecution': {
                execCodeInBackgroundThread: (...args: any[]) => execCodeInBackgroundThreadStub(...args)
            },
            '../api/kernels/backgroundExecution.js': {
                execCodeInBackgroundThread: (...args: any[]) => execCodeInBackgroundThreadStub(...args)
            },
            './completionDocumentationFormatter': {
                convertDocumentationToMarkdown: (documentation: string, language: string) => {
                    if (language === 'python') {
                        return { value: documentation };
                    }
                    return documentation;
                }
            },
            '../../platform/common/utils/regexp': {
                stripAnsi: (str: string) => str
            },
            '../../platform/common/helpers': {
                splitLines: (str: string) => str.split('\n')
            }
        });
        resolveCompletionItem = module.resolveCompletionItem;
        maxPendingKernelRequests = module.maxPendingKernelRequests;
    });

    teardown(() => {
        sinon.reset();
        disposables = dispose(disposables);
        serviceContainerInstance = undefined;
    });
    suite('Non-Python', () => {
        setup(() => {
            when(kernel.kernelConnectionMetadata).thenReturn(nonPythonKernel);
        });
        test('Return the same item if kernel is not idle', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);

            const statuses: Kernel.Status[] = [
                'busy',
                'starting',
                'restarting',
                'dead',
                'autorestarting',
                'dead',
                'terminating',
                'unknown'
            ];

            for (const status of statuses) {
                when(kernel.status).thenReturn(status);
                const result = await resolveCompletionItem(
                    completionItem,
                    undefined,
                    token,
                    instance(kernel),
                    kernelId,
                    'java',
                    document,
                    new Position(0, 4)
                );

                assert.strictEqual(result.documentation, completionItem.documentation);
            }
        });
        test('Return the same item if cancelled', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            deferred.resolve({
                channel: 'shell',
                content: {
                    status: 'ok',
                    data: {
                        'text/plain': 'Some documentation'
                    },
                    found: true,
                    metadata: {}
                },
                header: {} as any,
                metadata: {} as any,
                parent_header: {} as any
            });
            // Resolve the response 2s later
            when(kernelConnection.requestInspect(anything())).thenReturn(
                sleep(2000, disposables).then(() => deferred.promise)
            );

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            // Cancel the request 1s later
            void sleep(1000, disposables).then(() => tokenSource.cancel());
            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.isUndefined(result.documentation);
        });
        test('Return the same item if kernel does not reply in time (test timeout)', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            when(kernelConnection.requestInspect(anything())).thenReturn(deferred.promise);

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );

            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);

            assert.strictEqual(result.documentation, completionItem.documentation);
            verify(kernelConnection.requestInspect(anything())).once();
        });
        test('Resolve the documentation', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            deferred.resolve({
                channel: 'shell',
                content: {
                    status: 'ok',
                    data: {
                        'text/plain': 'Some documentation'
                    },
                    found: true,
                    metadata: {}
                },
                header: {} as any,
                metadata: {} as any,
                parent_header: {} as any
            });
            when(kernelConnection.requestInspect(anything())).thenReturn(deferred.promise);

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.strictEqual(result.documentation, 'Some documentation');
        });
        test('Resolve & leave documentation as is when nothing is returned from the kernel', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            deferred.resolve({
                channel: 'shell',
                content: {
                    status: 'ok',
                    data: {},
                    found: false,
                    metadata: {}
                },
                header: {} as any,
                metadata: {} as any,
                parent_header: {} as any
            });
            when(kernelConnection.requestInspect(anything())).thenReturn(deferred.promise);

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.isUndefined(result.documentation);
        });
        test('Resolve the documentation, even if it takes a few ms (less than timeout)', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            deferred.resolve({
                channel: 'shell',
                content: {
                    status: 'ok',
                    data: {
                        'text/plain': 'Some documentation'
                    },
                    found: true,
                    metadata: {}
                },
                header: {} as any,
                metadata: {} as any,
                parent_header: {} as any
            });
            when(kernelConnection.requestInspect(anything())).thenReturn(sleep(1000).then(() => deferred.promise));

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.strictEqual(result.documentation, 'Some documentation');
        });
        test('Never make any requests if we fail to get a response in time', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            when(kernelConnection.requestInspect(anything())).thenReturn(deferred.promise);
            const sendRequest = () =>
                resolveCompletionItem(
                    completionItem,
                    undefined,
                    token,
                    instance(kernel),
                    kernelId,
                    'java',
                    document,
                    new Position(0, 4)
                );

            // Send a completion request and it will not complete, but will time out.
            const [result0] = await Promise.all([sendRequest(), clock.tickAsync(5_000)]);
            assert.strictEqual(result0.documentation, completionItem.documentation);
            verify(kernelConnection.requestInspect(anything())).times(1);

            // Lets try to send a lot more & verify this is a noop.
            for (let index = 0; index < 100; index++) {
                void sendRequest();
            }

            // Verify we still send that one request (which is still pending).
            verify(kernelConnection.requestInspect(anything())).times(1);

            // From now on we will not send any requests as the previous never completed.
            reset(kernelConnection);
            when(kernelConnection.requestInspect(anything())).thenReturn(deferred.promise);
            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.strictEqual(result.documentation, completionItem.documentation);
            verify(kernelConnection.requestInspect(anything())).never();
        });
        test('Never queue more than 1 requests', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const requests: Deferred<IInspectReplyMsg>[] = [];
            when(kernelConnection.requestInspect(anything())).thenCall(() => {
                const deferred = createDeferred<IInspectReplyMsg>();
                requests.push(deferred);
                disposables.push(new Disposable(() => deferred.resolve())); // No dangling promises.
                return deferred.promise;
            });

            const sendRequest = () =>
                resolveCompletionItem(
                    completionItem,
                    undefined,
                    token,
                    instance(kernel),
                    kernelId,
                    'java',
                    document,
                    new Position(0, 4)
                );

            void sendRequest();
            await clock.tickAsync(10);

            for (let index = 0; index < maxPendingKernelRequests; index++) {
                // Asking for resolving another completion will not send a new request, as there are too many
                void sendRequest();
                await clock.tickAsync(100); // Wait for 500ms (lets see if the back off strategy works & does not send any requests)
                verify(kernelConnection.requestInspect(anything())).times(maxPendingKernelRequests);
                assert.strictEqual(requests.length, maxPendingKernelRequests);
            }

            // Complete one of the requests, this should allow another request to be sent
            requests.pop()?.resolve({ content: { status: 'ok', data: {}, found: false, metadata: {} } } as any);
            kernelStatusChangedSignal.emit('idle');
            await clock.tickAsync(100); // Wait for backoff strategy to work.
            verify(kernelConnection.requestInspect(anything())).times(maxPendingKernelRequests + 1);

            void sendRequest();
            void sendRequest();
            void sendRequest();
            void sendRequest();

            // After calling everything, nothing should be sent (as all have been cancelled).
            tokenSource.cancel();
            await clock.tickAsync(500); // Wait for backoff strategy to work.
            verify(kernelConnection.requestInspect(anything())).times(maxPendingKernelRequests + 1);
        });
        test('Cache the responses', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');
            const deferred = createDeferred<IInspectReplyMsg>();
            deferred.resolve({
                channel: 'shell',
                content: {
                    status: 'ok',
                    data: {
                        'text/plain': 'Some documentation'
                    },
                    found: true,
                    metadata: {}
                },
                header: {} as any,
                metadata: {} as any,
                parent_header: {} as any
            });
            when(kernelConnection.requestInspect(anything())).thenReturn(deferred.promise);

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            const resultPromise2 = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 4)
            );
            const [result2] = await Promise.all([resultPromise2, clock.tickAsync(5_000)]);
            assert.deepEqual(result, result2);
            // Only one request should have been sent
            verify(kernelConnection.requestInspect(anything())).once();

            const resultPromise3 = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'java',
                document,
                new Position(0, 1)
            );
            await Promise.all([resultPromise3, clock.tickAsync(5_000)]);
            // Should have sent the new request (as we do not have a cache for this)
            verify(kernelConnection.requestInspect(anything())).twice();
        });
    });
    suite('Python', () => {
        let resolveOutputs: Deferred<KernelMessage.IInspectReplyMsg['content']>;
        setup(async () => {
            when(kernel.kernelConnectionMetadata).thenReturn(pythonKernel);
            when(kernel.disposed).thenReturn(false);

            resolveOutputs = createDeferred<KernelMessage.IInspectReplyMsg['content']>();
            execCodeInBackgroundThreadStub.callsFake(() => resolveOutputs.promise);

            const container = mock<ServiceContainer>();
            const kernelProvider = mock<IKernelProvider>();
            const controllerRegistration = mock<IControllerRegistration>();
            when(controllerRegistration.getSelected(anything())).thenReturn(undefined);
            when(container.get<IKernelProvider>(IKernelProvider)).thenReturn(instance(kernelProvider));
            when(container.get<IDisposableRegistry>(IDisposableRegistry)).thenReturn([]);
            when(container.get<IControllerRegistration>(IControllerRegistration)).thenReturn(
                instance(controllerRegistration)
            );

            // Set the mocked instance
            serviceContainerInstance = instance(container);

            const pythonApi = mock<PythonExtension>();
            setPythonApi(instance(pythonApi));
            disposables.push(new Disposable(() => setPythonApi(undefined as any)));

            when(pythonApi.environments).thenReturn({ known: [] } as any);
        });
        test('Resolve the documentation', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('idle');

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'python',
                document,
                new Position(0, 4)
            );

            resolveOutputs.resolve({
                status: 'ok',
                data: {
                    'text/plain': 'Some documentation'
                },
                found: true,
                metadata: {}
            });

            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.strictEqual((result.documentation as MarkdownString).value, 'Some documentation');
        });
        test('Resolve the documentation even if kernel is busy', async () => {
            completionItem = new CompletionItem('One');
            completionItem.range = new Range(0, 4, 0, 4);
            when(kernel.status).thenReturn('busy');

            const resultPromise = resolveCompletionItem(
                completionItem,
                undefined,
                token,
                instance(kernel),
                kernelId,
                'python',
                document,
                new Position(0, 4)
            );

            resolveOutputs.resolve({
                status: 'ok',
                data: {
                    'text/plain': 'Some documentation'
                },
                found: true,
                metadata: {}
            });

            const [result] = await Promise.all([resultPromise, clock.tickAsync(5_000)]);
            assert.strictEqual((result.documentation as MarkdownString).value, 'Some documentation');
        });
    });
});
