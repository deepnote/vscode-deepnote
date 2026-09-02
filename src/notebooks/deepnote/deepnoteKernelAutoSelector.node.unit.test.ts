import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { DeepnoteKernelAutoSelector } from './deepnoteKernelAutoSelector.node';
import { ServerHandleRegistry } from '../../kernels/deepnote/deepnoteServerHandleRegistry.node';
import { DeepnoteToolkitDependencyResponse, IDeepnoteToolkitDependencyService } from '../../kernels/deepnote/types';
import {
    IDeepnoteLspClientManager,
    IDeepnoteServerProvider,
    IDeepnoteServerStarter
} from '../../kernels/deepnote/types';
import { IControllerRegistration, IVSCodeNotebookController } from '../controllers/types';
import { IDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { IPythonExtensionChecker } from '../../platform/api/types';
import { PythonEnvironmentFilter } from '../../platform/interpreter/filter/filterService';
import { PythonEnvironmentQuickPickItemProvider } from '../../platform/interpreter/pythonEnvironmentQuickPickProvider.node';
import { IJupyterRequestCreator } from '../../kernels/jupyter/types';
import { IConfigurationService } from '../../platform/common/types';
import { IDeepnoteNotebookManager } from '../types';
import { IKernelProvider, IKernel, IJupyterKernelSpec, KernelConnectionMetadata } from '../../kernels/types';
import { IDeepnoteNotebookInterpreters } from './deepnoteNotebookInterpreters';
import { IDeepnoteRequirementsHelper } from './deepnoteRequirementsHelper.node';
import {
    CancellationError,
    NotebookDocument,
    NotebookEditor,
    Uri,
    NotebookController,
    CancellationToken
} from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { getNotebookKey } from '../../platform/deepnote/deepnoteProjectUtils';
import { computeRequirementsHash } from './deepnoteProjectUtils';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

suite('DeepnoteKernelAutoSelector - rebuildController', () => {
    let selector: DeepnoteKernelAutoSelector;
    let mockDisposableRegistry: IDisposableRegistry;
    let mockControllerRegistration: IControllerRegistration;
    let mockPythonExtensionChecker: IPythonExtensionChecker;
    let mockServerProvider: IDeepnoteServerProvider;
    let mockLspClientManager: IDeepnoteLspClientManager;
    let mockRequestCreator: IJupyterRequestCreator;
    let mockConfigService: IConfigurationService;
    let mockNotebookManager: IDeepnoteNotebookManager;
    let mockKernelProvider: IKernelProvider;
    let mockRequirementsHelper: IDeepnoteRequirementsHelper;
    let mockServerStarter: IDeepnoteServerStarter;
    let mockOutputChannel: IOutputChannel;
    let mockInterpreterService: IInterpreterService;
    let registry: ServerHandleRegistry;
    let mockToolkitDependencyService: IDeepnoteToolkitDependencyService;
    let mockNotebookInterpreters: IDeepnoteNotebookInterpreters;
    let mockEnvironmentQuickPickProvider: PythonEnvironmentQuickPickItemProvider;
    let mockEnvironmentFilter: PythonEnvironmentFilter;

    let mockProgress: { report(value: { message?: string; increment?: number }): void };
    let mockCancellationToken: CancellationToken;

    let mockNotebook: NotebookDocument;
    let mockController: IVSCodeNotebookController;
    let mockNewController: IVSCodeNotebookController;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        resetVSCodeMocks();
        sandbox = sinon.createSandbox();

        // Create mocks for all dependencies
        mockDisposableRegistry = mock<IDisposableRegistry>();
        mockControllerRegistration = mock<IControllerRegistration>();
        mockPythonExtensionChecker = mock<IPythonExtensionChecker>();
        mockServerProvider = mock<IDeepnoteServerProvider>();
        mockLspClientManager = mock<IDeepnoteLspClientManager>();
        mockRequestCreator = mock<IJupyterRequestCreator>();
        mockConfigService = mock<IConfigurationService>();
        mockNotebookManager = mock<IDeepnoteNotebookManager>();
        mockKernelProvider = mock<IKernelProvider>();
        mockRequirementsHelper = mock<IDeepnoteRequirementsHelper>();
        mockServerStarter = mock<IDeepnoteServerStarter>();
        mockOutputChannel = mock<IOutputChannel>();
        mockInterpreterService = mock<IInterpreterService>();
        registry = new ServerHandleRegistry();
        mockToolkitDependencyService = mock<IDeepnoteToolkitDependencyService>();
        mockNotebookInterpreters = mock<IDeepnoteNotebookInterpreters>();
        when(mockNotebookInterpreters.get(anything())).thenReturn(undefined);
        // Mirrors the real store's pin -> details -> active chain, so tests keep driving resolution
        // through the existing getInterpreterDetails / getActiveInterpreter stubs.
        when(mockNotebookInterpreters.resolve(anything())).thenCall(async (uri: Uri) => {
            const service = instance(mockInterpreterService);
            const pinned = instance(mockNotebookInterpreters).get(uri);
            const fromPin = pinned ? await service.getInterpreterDetails(pinned) : undefined;

            return fromPin ?? (await service.getActiveInterpreter(uri));
        });
        mockEnvironmentQuickPickProvider = mock<PythonEnvironmentQuickPickItemProvider>();
        mockEnvironmentFilter = mock<PythonEnvironmentFilter>();
        when(mockToolkitDependencyService.ensureToolkitInstalled(anything(), anything(), anything())).thenResolve(
            DeepnoteToolkitDependencyResponse.ok
        );

        mockProgress = { report: sandbox.stub() };
        mockCancellationToken = mock<CancellationToken>();

        // Create mock notebook
        mockNotebook = {
            uri: Uri.parse('file:///test/notebook.deepnote?notebook=123'),
            notebookType: 'deepnote',
            metadata: { deepnoteProjectId: 'project-123' },
            // Add minimal required properties for NotebookDocument
            version: 1,
            isDirty: false,
            isUntitled: false,
            isClosed: false,
            cellCount: 0,
            cellAt: () => {
                throw new Error('Not implemented');
            },
            getCells: () => [],
            save: async () => true
        } as unknown as NotebookDocument;

        // Create mock controllers
        mockController = mock<IVSCodeNotebookController>();
        when(mockController.id).thenReturn('deepnote-config-kernel-old-env-id');
        when(mockController.controller).thenReturn({} as NotebookController);

        mockNewController = mock<IVSCodeNotebookController>();
        when(mockNewController.id).thenReturn('deepnote-config-kernel-new-env-id');
        when(mockNewController.controller).thenReturn({} as NotebookController);

        // Mock disposable registry - push returns the index
        when(mockDisposableRegistry.push(anything())).thenReturn(0);

        // Create selector instance
        selector = new DeepnoteKernelAutoSelector(
            instance(mockDisposableRegistry),
            instance(mockControllerRegistration),
            instance(mockPythonExtensionChecker),
            instance(mockServerProvider),
            instance(mockLspClientManager),
            instance(mockRequestCreator),
            undefined, // requestAgentCreator is optional
            instance(mockConfigService),
            instance(mockNotebookManager),
            instance(mockKernelProvider),
            instance(mockRequirementsHelper),
            instance(mockServerStarter),
            instance(mockOutputChannel),
            instance(mockInterpreterService),
            registry,
            instance(mockToolkitDependencyService),
            instance(mockNotebookInterpreters),
            instance(mockEnvironmentQuickPickProvider),
            instance(mockEnvironmentFilter)
        );
    });

    teardown(() => {
        sandbox.restore();
    });

    /** Mirrors the state ensureKernelSelectedWithInterpreter leaves behind, which isKernelReady reads. */
    function markKernelReady(interpreterId: string) {
        const internals = selector as unknown as {
            notebookControllers: Map<string, IVSCodeNotebookController>;
            notebookInterpreterIds: Map<string, string>;
            notebookConnectionMetadata: Map<string, { baseUrl: string }>;
        };
        const notebookKey = getNotebookKey(mockNotebook.uri);

        internals.notebookControllers.set(notebookKey, instance(mockController));
        internals.notebookInterpreterIds.set(notebookKey, interpreterId);
        internals.notebookConnectionMetadata.set(notebookKey, { baseUrl: 'http://localhost:8888' });
    }

    suite('rebuildController', () => {
        test('should proceed with environment switch despite pending cells', async () => {
            // This test verifies that rebuildController continues with the environment switch
            // even when cells are currently executing (pending)

            // Arrange
            const mockKernel = mock<IKernel>();
            const mockExecution = {
                pendingCells: [{ index: 0 }, { index: 1 }] // 2 cells pending
            };

            // Mock interpreter service to return an active interpreter
            const mockInterpreter: PythonEnvironment = {
                id: '/usr/bin/python3',
                uri: Uri.parse('/usr/bin/python3')
            };
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(mockInterpreter);

            when(mockKernelProvider.get(mockNotebook)).thenReturn(instance(mockKernel));
            when(mockKernelProvider.getKernelExecution(instance(mockKernel))).thenReturn(mockExecution as any);

            // Stub ensureKernelSelectedWithInterpreter to verify it's still called despite pending cells
            const ensureKernelSelectedWithInterpreterStub = sandbox
                .stub(selector, 'ensureKernelSelectedWithInterpreter')
                .resolves();
            // Act
            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            // Assert - should proceed despite pending cells
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.calledOnce,
                true,
                'ensureKernelSelected should be called even with pending cells'
            );
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.firstCall.args[0],
                mockNotebook,
                'ensureKernelSelected should be called with the notebook'
            );
        });

        test('should proceed without error when no kernel is running', async () => {
            // This test verifies that rebuildController works correctly when no kernel is active
            // (i.e., no cells have been executed yet)

            // Arrange
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);

            // Mock interpreter service to return an active interpreter
            const mockInterpreter: PythonEnvironment = {
                id: '/usr/bin/python3',
                uri: Uri.parse('/usr/bin/python3')
            };
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(mockInterpreter);

            // Stub ensureKernelSelectedWithInterpreter to verify it's called
            const ensureKernelSelectedWithInterpreterStub = sandbox
                .stub(selector, 'ensureKernelSelectedWithInterpreter')
                .resolves();

            // Act
            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            // Assert - should proceed normally without a kernel
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.calledOnce,
                true,
                'ensureKernelSelected should be called even when no kernel exists'
            );
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.firstCall.args[0],
                mockNotebook,
                'ensureKernelSelected should be called with the notebook'
            );
        });

        test('should complete successfully and delegate to ensureKernelSelectedWithInterpreter', async () => {
            // This test verifies that ensureKernelSelectedWithInterpreter completes successfully
            // and delegates kernel setup to ensureKernelSelected

            // Arrange
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);

            // Mock interpreter service to return an active interpreter
            const mockInterpreter: PythonEnvironment = {
                id: '/usr/bin/python3',
                uri: Uri.parse('/usr/bin/python3')
            };
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(mockInterpreter);

            // Stub ensureKernelSelectedWithInterpreter to verify delegation
            const ensureKernelSelectedWithInterpreterStub = sandbox
                .stub(selector, 'ensureKernelSelectedWithInterpreter')
                .resolves();

            // Act
            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            // Assert - method should complete without errors
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.calledOnce,
                true,
                'ensureKernelSelectedWithInterpreter should be called to set up the new environment'
            );
        });

        test('should pass cancellation token to ensureKernelSelectedWithInterpreter', async () => {
            // This test verifies that rebuildController correctly passes the cancellation token
            // to ensureKernelSelectedWithInterpreter, allowing the operation to be cancelled during execution

            // Arrange
            when(mockCancellationToken.isCancellationRequested).thenReturn(true);
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);

            // Mock interpreter service to return an active interpreter
            const mockInterpreter: PythonEnvironment = {
                id: '/usr/bin/python3',
                uri: Uri.parse('/usr/bin/python3')
            };
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(mockInterpreter);

            // Stub ensureKernelSelectedWithInterpreter to verify it receives the token
            const ensureKernelSelectedWithInterpreterStub = sandbox
                .stub(selector, 'ensureKernelSelectedWithInterpreter')
                .resolves();

            // Act
            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            // Assert
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.calledOnce,
                true,
                'ensureKernelSelectedWithInterpreter should be called once'
            );
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.firstCall.args[0],
                mockNotebook,
                'ensureKernelSelected should be called with the notebook'
            );
            assert.strictEqual(
                ensureKernelSelectedWithInterpreterStub.firstCall.args[4],
                instance(mockCancellationToken),
                'ensureKernelSelected should be called with the cancellation token'
            );
        });

        test('should keep the old server handle registered when the interpreter switch fails', async () => {
            // Old handle already tracked; setup fails so no new handle is ever registered.
            const notebookKey = getNotebookKey(mockNotebook.uri);
            const oldServerHandle = 'old-server-handle';
            registry.set(notebookKey, oldServerHandle);

            const mockInterpreter: PythonEnvironment = {
                id: '/usr/bin/python3',
                uri: Uri.parse('/usr/bin/python3')
            };
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(mockInterpreter);
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').rejects(new Error('startServer failed'));

            await assert.isRejected(
                selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken))
            );

            // The old handle must remain registered so the selected controller keeps resolving.
            verify(mockServerProvider.unregisterServer(oldServerHandle)).never();
        });

        test('should unregister the old server handle after switching to a different interpreter', async () => {
            const notebookKey = getNotebookKey(mockNotebook.uri);
            const oldServerHandle = 'old-server-handle';
            const newServerHandle = 'new-server-handle';
            registry.set(notebookKey, oldServerHandle);

            const mockInterpreter: PythonEnvironment = {
                id: '/usr/bin/python3',
                uri: Uri.parse('/usr/bin/python3')
            };
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(mockInterpreter);
            // Emulate the side effects of a real setup: a new handle, plus the controller/connection
            // state that marks the notebook as running on the new interpreter. Without the latter the
            // switch counts as not having taken, and the old handle is deliberately kept.
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').callsFake(async () => {
                registry.set(notebookKey, newServerHandle);
                markKernelReady(mockInterpreter.id);
            });

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            verify(mockServerProvider.unregisterServer(oldServerHandle)).once();
            verify(mockServerProvider.unregisterServer(newServerHandle)).never();
            assert.strictEqual(
                registry.get(notebookKey),
                newServerHandle,
                'registry should track the new handle after a successful switch'
            );
        });
    });

    suite('ensureControllerSelectedForNotebook', () => {
        // Every Deepnote controller for one notebook carries the same id, derived from the notebook URI.
        const CONTROLLER_ID = 'deepnote-notebook-/test/notebook.deepnote';

        function createController(): IVSCodeNotebookController {
            const controller = mock<IVSCodeNotebookController>();
            when(controller.id).thenReturn(CONTROLLER_ID);
            when(controller.connection).thenReturn({ id: CONTROLLER_ID } as KernelConnectionMetadata);
            when(controller.controller).thenReturn({
                updateNotebookAffinity: sandbox.stub()
            } as unknown as NotebookController);

            return instance(controller);
        }

        setup(() => {
            when(mockCancellationToken.isCancellationRequested).thenReturn(false);
            when(mockedVSCodeNamespaces.window.visibleNotebookEditors).thenReturn([
                { notebook: mockNotebook } as NotebookEditor
            ]);
            when(mockedVSCodeNamespaces.commands.executeCommand('notebook.selectKernel', anything())).thenResolve();
        });

        test('selects the kernel when the recorded controller was replaced by one with the same id', async () => {
            // The recorded controller was disposed and rebuilt; only object identity tells the two apart,
            // and skipping selectKernel here leaves the notebook bound to the dead one.
            when(mockControllerRegistration.getSelected(anything())).thenReturn(createController());

            await selector.ensureControllerSelectedForNotebook(
                mockNotebook,
                createController(),
                instance(mockCancellationToken)
            );

            verify(mockedVSCodeNamespaces.commands.executeCommand('notebook.selectKernel', anything())).once();
        });

        test('skips the kernel picker when the recorded controller is the one being selected', async () => {
            const controller = createController();
            when(mockControllerRegistration.getSelected(anything())).thenReturn(controller);

            await selector.ensureControllerSelectedForNotebook(
                mockNotebook,
                controller,
                instance(mockCancellationToken)
            );

            verify(mockedVSCodeNamespaces.commands.executeCommand('notebook.selectKernel', anything())).never();
        });
    });

    suite('ensureEnvironmentConfiguredBeforeExecution', () => {
        const nonCancelledToken: CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => {} }) as any
        };

        test('routes an interpreter change through rebuildController, so the old LSP and server handle are torn down', async () => {
            const notebookKey = mockNotebook.uri.toString();
            const interpreterA: PythonEnvironment = {
                id: '/usr/bin/python3.10',
                uri: Uri.parse('/usr/bin/python3.10')
            };
            const interpreterB: PythonEnvironment = {
                id: '/usr/bin/python3.12',
                uri: Uri.parse('/usr/bin/python3.12')
            };

            // The notebook already ran on A.
            const selectorAny = selector as any;
            selectorAny.notebookControllers.set(notebookKey, instance(mockController));
            selectorAny.notebookInterpreterIds.set(notebookKey, interpreterA.id);

            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(interpreterB);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_opts: any, task: any) =>
                task({ report: sandbox.stub() }, nonCancelledToken)
            );

            const ensureStub = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();
            const rebuildStub = sandbox.stub(selector, 'rebuildController').callsFake(async () => {
                selectorAny.notebookControllers.set(notebookKey, instance(mockNewController));

                return true;
            });

            const result = await selector.ensureEnvironmentConfiguredBeforeExecution(mockNotebook, nonCancelledToken);

            assert.strictEqual(result, true, 'the notebook is ready on the new interpreter');
            assert.strictEqual(rebuildStub.calledOnce, true, 'an interpreter change must go through the rebuild path');
            assert.strictEqual(
                ensureStub.called,
                false,
                'setting up directly would skip stopping the old LSP clients and unregistering the old handle'
            );
        });

        test('blocks execution when the rebuild for a changed interpreter does not take', async () => {
            const notebookKey = mockNotebook.uri.toString();
            const selectorAny = selector as any;
            selectorAny.notebookControllers.set(notebookKey, instance(mockController));
            selectorAny.notebookInterpreterIds.set(notebookKey, '/usr/bin/python3.10');

            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve({
                id: '/usr/bin/python3.12',
                uri: Uri.parse('/usr/bin/python3.12')
            });
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_opts: any, task: any) =>
                task({ report: sandbox.stub() }, nonCancelledToken)
            );
            sandbox.stub(selector, 'rebuildController').resolves(false);

            const result = await selector.ensureEnvironmentConfiguredBeforeExecution(mockNotebook, nonCancelledToken);

            assert.strictEqual(result, false, 'cells must not run against a kernel the rebuild never produced');
        });

        test('sets the kernel up directly on the first run, with no interpreter to switch away from', async () => {
            const notebookKey = mockNotebook.uri.toString();
            const interpreter: PythonEnvironment = {
                id: '/usr/bin/python3.12',
                uri: Uri.parse('/usr/bin/python3.12')
            };
            const selectorAny = selector as any;

            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(interpreter);
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall((_opts: any, task: any) =>
                task({ report: sandbox.stub() }, nonCancelledToken)
            );

            const rebuildStub = sandbox.stub(selector, 'rebuildController').resolves(true);
            const ensureStub = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').callsFake(async () => {
                selectorAny.notebookControllers.set(notebookKey, instance(mockNewController));
            });

            const result = await selector.ensureEnvironmentConfiguredBeforeExecution(mockNotebook, nonCancelledToken);

            assert.strictEqual(result, true);
            assert.strictEqual(ensureStub.calledOnce, true, 'a first run is a plain setup');
            assert.strictEqual(rebuildStub.called, false, 'there is nothing to tear down yet');
            assert.deepStrictEqual(ensureStub.firstCall.args[1], interpreter);
        });

        suite('toolkit dependency responses', () => {
            const interpreter: PythonEnvironment = {
                id: '/usr/bin/python3.10',
                uri: Uri.parse('/usr/bin/python3.10')
            };

            function whenDependency(response: DeepnoteToolkitDependencyResponse) {
                when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(interpreter);
                when(
                    mockToolkitDependencyService.ensureToolkitInstalled(anything(), anything(), anything())
                ).thenResolve(response);

                return sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();
            }

            test('a failed install blocks execution AND surfaces an error', async () => {
                const ensureStub = whenDependency(DeepnoteToolkitDependencyResponse.failed);

                const result = await selector.ensureEnvironmentConfiguredBeforeExecution(
                    mockNotebook,
                    nonCancelledToken
                );

                assert.strictEqual(result, false, 'a failed install must block execution');
                assert.strictEqual(ensureStub.called, false, 'the kernel must not be set up');
                verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).atLeast(1);
            });

            test('declining the install blocks execution without an error message', async () => {
                const ensureStub = whenDependency(DeepnoteToolkitDependencyResponse.cancel);

                const result = await selector.ensureEnvironmentConfiguredBeforeExecution(
                    mockNotebook,
                    nonCancelledToken
                );

                assert.strictEqual(result, false, 'a declined install must block execution');
                assert.strictEqual(ensureStub.called, false);
                verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).never();
            });

            test('opting to pick another interpreter blocks this run without an error message', async () => {
                const ensureStub = whenDependency(DeepnoteToolkitDependencyResponse.selectDifferentInterpreter);

                const result = await selector.ensureEnvironmentConfiguredBeforeExecution(
                    mockNotebook,
                    nonCancelledToken
                );

                assert.strictEqual(result, false, 'the notebook must not run until it is reconfigured');
                assert.strictEqual(ensureStub.called, false);
                verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).never();
            });
        });

        test('should return true immediately when controller exists for the same interpreter', async () => {
            const notebookKey = mockNotebook.uri.toString();
            const interpreterA: PythonEnvironment = {
                id: '/usr/bin/python3.10',
                uri: Uri.parse('/usr/bin/python3.10')
            };

            // Prime the internal maps: controller exists for interpreter A
            const selectorAny = selector as any;
            selectorAny.notebookControllers.set(notebookKey, instance(mockController));
            selectorAny.notebookInterpreterIds.set(notebookKey, interpreterA.id);
            selectorAny.notebookConnectionMetadata.set(notebookKey, { baseUrl: 'http://127.0.0.1:8888' });

            // Active interpreter is still A
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(interpreterA);

            // Stub ensureKernelSelectedWithInterpreter — should NOT be called
            const ensureStub = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            const result = await selector.ensureEnvironmentConfiguredBeforeExecution(mockNotebook, nonCancelledToken);

            assert.strictEqual(result, true, 'Should return true (fast path)');
            assert.strictEqual(ensureStub.called, false, 'Should NOT call ensureKernelSelectedWithInterpreter');
        });

        test('does NOT treat the controller registered at open as ready (it has no server yet)', async () => {
            const notebookKey = mockNotebook.uri.toString();
            const interpreterA: PythonEnvironment = {
                id: '/usr/bin/python3.10',
                uri: Uri.parse('/usr/bin/python3.10')
            };

            // What registerControllerForNotebook leaves behind: a controller whose connection has no
            // baseUrl. Short-circuiting here would run cells against a server that was never started.
            const selectorAny = selector as any;
            selectorAny.notebookControllers.set(notebookKey, instance(mockController));
            selectorAny.notebookInterpreterIds.set(notebookKey, interpreterA.id);
            selectorAny.notebookConnectionMetadata.set(notebookKey, { baseUrl: '' });

            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(interpreterA);

            const ensureStub = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.ensureEnvironmentConfiguredBeforeExecution(mockNotebook, nonCancelledToken);

            assert.strictEqual(ensureStub.called, true, 'must set the kernel up before executing');
        });
    });

    // REAL TDD Tests - These should FAIL if bugs exist
    suite('Bug Detection: Kernel Selection', () => {
        test('Should select the first Python kernel from available specs', () => {
            // The selectKernelSpec method selects the first Python kernel available

            const kernelSpecs: IJupyterKernelSpec[] = [
                createMockKernelSpec('.env', '.env Python', 'python'),
                createMockKernelSpec('python3', 'Python 3', 'python')
            ];

            const selected = selector.selectKernelSpec(kernelSpecs);

            // Should select the first Python kernel
            assert.strictEqual(selected.language, 'python', 'Should select a Python kernel');
            assert.strictEqual(selected.name, '.env', 'Should select the first Python kernel');
        });

        test('Should fall back to python3 named kernel when no python language kernel exists first', () => {
            // Documents fallback behavior - finds python3 by name if no python language match

            const kernelSpecs: IJupyterKernelSpec[] = [
                createMockKernelSpec('javascript', 'JavaScript', 'javascript'),
                createMockKernelSpec('python3', 'Python 3', 'python')
            ];

            const selected = selector.selectKernelSpec(kernelSpecs);

            assert.strictEqual(selected.name, 'python3', 'Should find python3 kernel');
        });

        test('Kernel selection: Should fall back to first available kernel when no Python kernel exists', () => {
            const kernelSpecs: IJupyterKernelSpec[] = [
                createMockKernelSpec('javascript', 'JavaScript', 'javascript'),
                createMockKernelSpec('r', 'R', 'r')
            ];

            const selected = selector.selectKernelSpec(kernelSpecs);

            assert.strictEqual(selected.name, 'javascript', 'Should fall back to first available kernel');
        });

        test('Kernel selection: Should throw when no kernel specs are available', () => {
            const kernelSpecs: IJupyterKernelSpec[] = [];

            assert.throws(
                () => selector.selectKernelSpec(kernelSpecs),
                /No kernel specs available/,
                'Should throw when no kernel specs are available'
            );
        });
    });

    suite('Requirements Optimization', () => {
        suite('computeRequirementsHash', () => {
            test('should return empty string for null/undefined', () => {
                const result1 = computeRequirementsHash(null);
                const result2 = computeRequirementsHash(undefined);

                assert.strictEqual(result1, '');
                assert.strictEqual(result2, '');
            });

            test('should return empty string for non-array input', () => {
                const result1 = computeRequirementsHash('not-an-array' as any);
                const result2 = computeRequirementsHash(123 as any);
                const result3 = computeRequirementsHash({} as any);

                assert.strictEqual(result1, '');
                assert.strictEqual(result2, '');
                assert.strictEqual(result3, '');
            });

            test('should return empty string for empty array', () => {
                const result = computeRequirementsHash([]);

                assert.strictEqual(result, '');
            });

            test('should filter out non-string entries', () => {
                const requirements = ['pandas', 123, 'numpy', null, 'scipy', undefined];
                const result = computeRequirementsHash(requirements);

                // Should only include string entries
                assert.strictEqual(result, 'numpy|pandas|scipy');
            });

            test('should trim whitespace from requirements', () => {
                const requirements = ['  pandas  ', 'numpy\t', '\nscipy'];
                const result = computeRequirementsHash(requirements);

                assert.strictEqual(result, 'numpy|pandas|scipy');
            });

            test('should filter out empty strings', () => {
                const requirements = ['pandas', '', '  ', 'numpy', '\t\n'];
                const result = computeRequirementsHash(requirements);

                assert.strictEqual(result, 'numpy|pandas');
            });

            test('should sort requirements alphabetically', () => {
                const requirements = ['scipy', 'pandas', 'numpy', 'matplotlib'];
                const result = computeRequirementsHash(requirements);

                assert.strictEqual(result, 'matplotlib|numpy|pandas|scipy');
            });

            test('should deduplicate requirements', () => {
                const requirements = ['pandas', 'numpy', 'pandas', 'scipy', 'numpy'];
                const result = computeRequirementsHash(requirements);

                // Should have each requirement only once
                assert.strictEqual(result, 'numpy|pandas|scipy');
            });

            test('should handle version specifiers', () => {
                const requirements = ['pandas>=1.0.0', 'numpy==1.21.0', 'scipy<2.0'];
                const result = computeRequirementsHash(requirements);

                assert.strictEqual(result, 'numpy==1.21.0|pandas>=1.0.0|scipy<2.0');
            });

            test('should produce same hash for same requirements in different order', () => {
                const requirements1 = ['pandas', 'numpy', 'scipy'];
                const requirements2 = ['scipy', 'pandas', 'numpy'];

                const hash1 = computeRequirementsHash(requirements1);
                const hash2 = computeRequirementsHash(requirements2);

                assert.strictEqual(hash1, hash2);
            });

            test('should produce different hash for different requirements', () => {
                const requirements1 = ['pandas', 'numpy'];
                const requirements2 = ['pandas', 'scipy'];

                const hash1 = computeRequirementsHash(requirements1);
                const hash2 = computeRequirementsHash(requirements2);

                assert.notStrictEqual(hash1, hash2);
            });
        });

        suite('getExistingRequirementsHash', () => {
            test('parsing logic correctness', () => {
                // Test the parsing logic directly by calling computeRequirementsHash
                // with a parsed file-like array (mimics what getExistingRequirementsHash does)
                const fileLines = ['# This is a comment', 'pandas', '', '  numpy  ', 'scipy', '# Another comment'];

                // Filter out comments and empty lines (same logic as getExistingRequirementsHash)
                const requirements = fileLines
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && !line.startsWith('#'));

                const hash = computeRequirementsHash(requirements);

                // Should have filtered and sorted correctly
                assert.strictEqual(hash, 'numpy|pandas|scipy');
            });
        });
    });

    suite('per-notebook interpreter', () => {
        const ACTIVE: PythonEnvironment = { id: '/usr/bin/python3', uri: Uri.file('/usr/bin/python3') };
        const PINNED: PythonEnvironment = { id: '/envs/pinned/bin/python', uri: Uri.file('/envs/pinned/bin/python') };

        test('runs the notebook on the interpreter pinned to it, not the workspace one', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(ACTIVE);
            when(mockNotebookInterpreters.get(anything())).thenReturn(PINNED.uri);
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(PINNED);
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);

            const stub = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            assert.strictEqual(stub.firstCall.args[1], PINNED, 'the pinned interpreter must win');
        });

        test('falls back to the workspace interpreter when the pinned one no longer resolves', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(ACTIVE);
            when(mockNotebookInterpreters.get(anything())).thenReturn(Uri.file('/envs/deleted/bin/python'));
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(undefined);
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);

            const stub = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            assert.strictEqual(stub.firstCall.args[1], ACTIVE, 'a dangling pin must not block the notebook');
        });
    });

    suite('reselecting the interpreter a notebook already runs on', () => {
        const SAME: PythonEnvironment = { id: '/usr/bin/python3', uri: Uri.file('/usr/bin/python3') };
        const OTHER: PythonEnvironment = { id: '/envs/other/bin/python', uri: Uri.file('/envs/other/bin/python') };

        setup(() => {
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);
            when(mockLspClientManager.stopLspClients(anything(), anything())).thenResolve();
            when(mockControllerRegistration.getSelected(mockNotebook)).thenReturn(instance(mockController));
            when(mockCancellationToken.isCancellationRequested).thenReturn(false);
            // Re-selection touches the real controller, unlike the tests that stub setup out.
            when(mockController.controller).thenReturn({
                updateNotebookAffinity: sandbox.stub()
            } as unknown as NotebookController);
        });

        test('does not tear anything down, and keeps the kernel', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(SAME);
            markKernelReady(SAME.id);
            const setup = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            const rebuilt = await selector.rebuildController(
                mockNotebook,
                mockProgress,
                instance(mockCancellationToken)
            );

            assert.isTrue(rebuilt);
            assert.isFalse(setup.called, 'the kernel must not be set up again');
            verify(mockLspClientManager.stopLspClients(anything(), anything())).never();
            verify(mockToolkitDependencyService.ensureToolkitInstalled(anything(), anything(), anything())).never();
        });

        test('still rebuilds when the notebook is on that interpreter but has no running kernel', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(SAME);
            const setup = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            assert.isTrue(setup.called, 'a dead kernel on the same interpreter still needs rebuilding');
        });

        test('still rebuilds when a different interpreter is chosen', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(OTHER);
            markKernelReady(SAME.id);
            const setup = sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            assert.isTrue(setup.called, 'a genuine switch must still rebuild');
        });
    });

    suite('rebuildController reports whether the switch took', () => {
        const INTERPRETER: PythonEnvironment = { id: '/usr/bin/python3', uri: Uri.file('/usr/bin/python3') };

        setup(() => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(INTERPRETER);
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);
        });

        test('false when the user declines installing the toolkit', async () => {
            when(mockToolkitDependencyService.ensureToolkitInstalled(anything(), anything(), anything())).thenResolve(
                DeepnoteToolkitDependencyResponse.cancel
            );

            const rebuilt = await selector.rebuildController(
                mockNotebook,
                mockProgress,
                instance(mockCancellationToken)
            );

            assert.isFalse(rebuilt, 'a declined toolkit install must not report a successful switch');
        });

        test('false when there is no interpreter to rebuild onto', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(undefined);

            const rebuilt = await selector.rebuildController(
                mockNotebook,
                mockProgress,
                instance(mockCancellationToken)
            );

            assert.isFalse(rebuilt);
        });

        test('false when setup returns without leaving the notebook on a running kernel', async () => {
            // ensureKernelSelectedWithInterpreter can bail without throwing (no Python extension, say),
            // so the outcome is read from the resulting state rather than from it having been called.
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            const rebuilt = await selector.rebuildController(
                mockNotebook,
                mockProgress,
                instance(mockCancellationToken)
            );

            assert.isFalse(rebuilt, 'no controller was registered, so the switch did not take');
        });
    });

    suite('LSP clients across a controller rebuild', () => {
        const INTERPRETER: PythonEnvironment = { id: '/usr/bin/python3', uri: Uri.file('/usr/bin/python3') };

        setup(() => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(INTERPRETER);
            when(mockKernelProvider.get(mockNotebook)).thenReturn(undefined);
            when(mockLspClientManager.stopLspClients(anything())).thenResolve();
            when(mockLspClientManager.stopLspClients(anything(), anything())).thenResolve();
        });

        test('leaves them running when there is no interpreter to switch to', async () => {
            when(mockInterpreterService.getActiveInterpreter(anything())).thenResolve(undefined);

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            verify(mockLspClientManager.stopLspClients(anything(), anything())).never();
        });

        test('leaves them running when the user declines installing the toolkit', async () => {
            when(mockToolkitDependencyService.ensureToolkitInstalled(anything(), anything(), anything())).thenResolve(
                DeepnoteToolkitDependencyResponse.cancel
            );

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            verify(mockLspClientManager.stopLspClients(anything(), anything())).never();
        });

        test('stops them once the switch actually goes ahead', async () => {
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            verify(mockLspClientManager.stopLspClients(anything(), anything())).once();
        });

        test('starts them again on the previous interpreter when the setup throws', async () => {
            const previous: PythonEnvironment = { id: 'previous-id', uri: Uri.file('/envs/previous/bin/python') };
            // The interpreter the notebook was on before this switch.
            (selector as unknown as { notebookInterpreterIds: Map<string, string> }).notebookInterpreterIds.set(
                getNotebookKey(mockNotebook.uri),
                previous.id
            );
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(previous);
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').rejects(new Error('server did not start'));

            await assert.isRejected(
                selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken))
            );

            verify(mockLspClientManager.startLspClients(anything(), previous)).once();
        });

        test('puts them back on the previous interpreter when setup returns without a working kernel', async () => {
            const previous: PythonEnvironment = { id: 'previous-id', uri: Uri.file('/envs/previous/bin/python') };
            (selector as unknown as { notebookInterpreterIds: Map<string, string> }).notebookInterpreterIds.set(
                getNotebookKey(mockNotebook.uri),
                previous.id
            );
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(previous);
            // Returns rather than throwing, and leaves no running kernel behind.
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            const rebuilt = await selector.rebuildController(
                mockNotebook,
                mockProgress,
                instance(mockCancellationToken)
            );

            assert.isFalse(rebuilt);
            verify(mockLspClientManager.startLspClients(anything(), previous)).once();
        });

        test('does NOT put them back when the notebook closed during the setup it abandoned', async () => {
            const previous: PythonEnvironment = { id: 'previous-id', uri: Uri.file('/envs/previous/bin/python') };
            const closedNotebook = { ...mockNotebook, isClosed: true } as unknown as NotebookDocument;
            (selector as unknown as { notebookInterpreterIds: Map<string, string> }).notebookInterpreterIds.set(
                getNotebookKey(mockNotebook.uri),
                previous.id
            );
            when(mockKernelProvider.get(anything())).thenReturn(undefined);
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(previous);
            // Abandoning setup for a closed notebook looks exactly like a switch that did not take.
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            const rebuilt = await selector.rebuildController(
                closedNotebook,
                mockProgress,
                instance(mockCancellationToken)
            );

            assert.isFalse(rebuilt);
            // Restoring here would start a pylsp process that onDidCloseNotebook has already stopped
            // and will never be asked to stop again.
            verify(mockLspClientManager.startLspClients(anything(), previous)).never();
        });

        test('stops the new interpreter clients before restoring, so a live one cannot block it', async () => {
            const previous: PythonEnvironment = { id: 'previous-id', uri: Uri.file('/envs/previous/bin/python') };
            (selector as unknown as { notebookInterpreterIds: Map<string, string> }).notebookInterpreterIds.set(
                getNotebookKey(mockNotebook.uri),
                previous.id
            );
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(previous);
            sandbox.stub(selector, 'ensureKernelSelectedWithInterpreter').resolves();

            await selector.rebuildController(mockNotebook, mockProgress, instance(mockCancellationToken));

            // Once for the switch itself, once more before putting the previous clients back.
            verify(mockLspClientManager.stopLspClients(anything(), anything())).once();
            verify(mockLspClientManager.stopLspClients(anything())).once();
        });

        test('stops them when the notebook is closed, so the process does not outlive it', () => {
            (selector as unknown as { onDidCloseNotebook(notebook: NotebookDocument): void }).onDidCloseNotebook(
                mockNotebook
            );

            verify(mockLspClientManager.stopLspClients(anything())).once();
        });
    });

    suite('setup failures leave the notebook adoptable', () => {
        const liveToken: CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        };
        const INTERPRETER_A = '/usr/bin/python3.10';
        const INTERPRETER_B: PythonEnvironment = {
            id: '/usr/bin/python3.12',
            uri: Uri.parse('/usr/bin/python3.12')
        };

        test('does not mark the notebook ready for an interpreter whose setup threw', async () => {
            const notebookKey = getNotebookKey(mockNotebook.uri);
            const selectorAny = selector as any;

            // Already running on A.
            selectorAny.notebookControllers.set(notebookKey, instance(mockController));
            selectorAny.notebookInterpreterIds.set(notebookKey, INTERPRETER_A);
            selectorAny.notebookConnectionMetadata.set(notebookKey, { baseUrl: 'http://127.0.0.1:8888' });

            // Setup for B gets past startServer and then fails.
            when(mockServerStarter.startServer(anything(), anything(), anything())).thenResolve({
                url: 'http://127.0.0.1:9999',
                token: '',
                jupyterPort: 9999,
                lspPort: 9998
            } as never);
            when(mockLspClientManager.startLspClients(anything(), anything(), anything())).thenResolve();

            await assert.isRejected(
                selector.ensureKernelSelectedWithInterpreter(
                    mockNotebook,
                    INTERPRETER_B,
                    notebookKey,
                    mockProgress,
                    liveToken
                )
            );

            assert.strictEqual(
                selectorAny.notebookInterpreterIds.get(notebookKey),
                INTERPRETER_A,
                'a half-finished setup must not claim the notebook now runs on the new interpreter'
            );
        });
    });

    suite('notebook closed during setup', () => {
        const liveToken: CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined })
        };

        test('does not start language servers for a notebook that closed while the server was starting', async () => {
            const notebookKey = getNotebookKey(mockNotebook.uri);
            const interpreter: PythonEnvironment = {
                id: '/usr/bin/python3.12',
                uri: Uri.parse('/usr/bin/python3.12')
            };
            // Server startup can take two minutes; the close handler has already run by the time it returns.
            const closedNotebook = { ...mockNotebook, isClosed: true } as unknown as NotebookDocument;

            when(mockServerStarter.startServer(anything(), anything(), anything())).thenResolve({
                url: 'http://127.0.0.1:9999',
                token: '',
                jupyterPort: 9999,
                lspPort: 9998
            } as never);

            await selector
                .ensureKernelSelectedWithInterpreter(closedNotebook, interpreter, notebookKey, mockProgress, liveToken)
                .catch(() => undefined);

            verify(mockLspClientManager.startLspClients(anything(), anything(), anything())).never();
        });

        test('registers nothing for it, so the close teardown is not undone behind its back', async () => {
            const notebookKey = getNotebookKey(mockNotebook.uri);
            const interpreter: PythonEnvironment = {
                id: '/usr/bin/python3.12',
                uri: Uri.parse('/usr/bin/python3.12')
            };
            const closedNotebook = { ...mockNotebook, isClosed: true } as unknown as NotebookDocument;

            when(mockServerStarter.startServer(anything(), anything(), anything())).thenResolve({
                url: 'http://127.0.0.1:9999',
                token: '',
                jupyterPort: 9999,
                lspPort: 9998
            } as never);

            await selector
                .ensureKernelSelectedWithInterpreter(closedNotebook, interpreter, notebookKey, mockProgress, liveToken)
                .catch(() => undefined);

            // onDidCloseNotebook has already run and does not fire twice, so anything registered here
            // would outlive the notebook for the rest of the session.
            assert.isUndefined(registry.get(notebookKey), 'the server handle must not be tracked');
            verify(mockServerProvider.registerServer(anything(), anything())).never();
            verify(mockControllerRegistration.addOrUpdate(anything(), anything())).never();
        });
    });

    suite('applyInterpreter', () => {
        const PREVIOUS = Uri.file('/envs/previous/bin/python');
        const CHOSEN: PythonEnvironment = { id: '/envs/chosen/bin/python', uri: Uri.file('/envs/chosen/bin/python') };

        /** Models the real store: `get` reflects the last `set`, which is what the restore guard reads. */
        function withPin(initial: Uri | undefined) {
            let current = initial;

            when(mockNotebookInterpreters.get(anything())).thenCall(() => current);
            when(mockNotebookInterpreters.set(anything(), anything())).thenCall(
                async (_uri: Uri, interpreter: Uri | undefined) => {
                    current = interpreter;
                }
            );
        }

        /** withProgress runs its callback for real; the outcome comes from the stubbed rebuild. */
        function whenRebuild(outcome: { rebuilt?: boolean; throws?: Error }) {
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                async (_options, callback) => callback({ report: () => undefined }, instance(mockCancellationToken))
            );

            return sandbox
                .stub(selector, 'rebuildController')
                .callsFake(() =>
                    outcome.throws ? Promise.reject(outcome.throws) : Promise.resolve(!!outcome.rebuilt)
                );
        }

        test('keeps the new interpreter when the rebuild takes', async () => {
            withPin(PREVIOUS);
            whenRebuild({ rebuilt: true });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            verify(mockNotebookInterpreters.set(anything(), CHOSEN.uri)).once();
            verify(mockNotebookInterpreters.set(anything(), PREVIOUS)).never();
        });

        test('restores the previous interpreter when the rebuild does not take', async () => {
            withPin(PREVIOUS);
            whenRebuild({ rebuilt: false });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            verify(mockNotebookInterpreters.set(anything(), PREVIOUS)).once();
        });

        test('clears the pin when the rebuild does not take and there was none before', async () => {
            withPin(undefined);
            whenRebuild({ rebuilt: false });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            verify(mockNotebookInterpreters.set(anything(), undefined)).once();
        });

        test('restores the previous interpreter when the rebuild is cancelled', async () => {
            withPin(PREVIOUS);
            whenRebuild({ throws: new CancellationError() });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            verify(mockNotebookInterpreters.set(anything(), PREVIOUS)).once();
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).never();
        });

        test('keeps a pin chosen during the failed rebuild instead of clobbering it', async () => {
            const NEWER_PIN = Uri.file('/envs/newer/bin/python');
            withPin(PREVIOUS);
            // The toolkit prompt's "Select a different Interpreter" re-enters applyInterpreter and
            // pins another interpreter before this rebuild reports that it did not take.
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                async (_options, callback) => callback({ report: () => undefined }, instance(mockCancellationToken))
            );
            sandbox.stub(selector, 'rebuildController').callsFake(async () => {
                await instance(mockNotebookInterpreters).set(mockNotebook.uri, NEWER_PIN);

                return false;
            });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            assert.strictEqual(
                instance(mockNotebookInterpreters).get(mockNotebook.uri)?.toString(),
                NEWER_PIN.toString(),
                'the newer pin must survive'
            );
        });

        test('restores the previous interpreter when the rebuild throws', async () => {
            withPin(PREVIOUS);
            whenRebuild({ throws: new Error('server did not start') });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            verify(mockNotebookInterpreters.set(anything(), PREVIOUS)).once();
        });

        test('keeps a pin chosen during a rebuild that throws instead of clobbering it', async () => {
            const NEWER_PIN = Uri.file('/envs/newer/bin/python');
            withPin(PREVIOUS);
            // A second switch pins another interpreter while this rebuild is still running, and this
            // one then fails: the failure must undo only its own pin, not the newer one.
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                async (_options, callback) => callback({ report: () => undefined }, instance(mockCancellationToken))
            );
            sandbox.stub(selector, 'rebuildController').callsFake(async () => {
                await instance(mockNotebookInterpreters).set(mockNotebook.uri, NEWER_PIN);

                throw new Error('server did not start');
            });

            await selector.applyInterpreter(mockNotebook, CHOSEN);

            assert.strictEqual(
                instance(mockNotebookInterpreters).get(mockNotebook.uri)?.toString(),
                NEWER_PIN.toString(),
                'the newer pin must survive'
            );
        });
    });

    suite('cancellation is not reported as a failure', () => {
        test('a cancelled kernel selection does not show an error message', async () => {
            await selector.handleKernelSelectionError(new CancellationError(), mockNotebook);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).never();
        });

        test('a generic kernel selection failure still shows an error message', async () => {
            await selector.handleKernelSelectionError(new Error('kernel did not start'), mockNotebook);

            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything(), anything(), anything())).once();
        });
    });
});

/**
 * Helper function to create mock kernel specs
 */
function createMockKernelSpec(name: string, displayName: string, language: string): IJupyterKernelSpec {
    return {
        name,
        display_name: displayName,
        language,
        executable: '/usr/bin/python3',
        argv: ['python3', '-m', 'ipykernel_launcher', '-f', '{connection_file}']
    };
}
