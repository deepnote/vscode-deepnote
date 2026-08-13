// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable no-void */
/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import * as sinon from 'sinon';
import {
    Disposable,
    EventEmitter,
    NotebookCell,
    NotebookCellKind,
    NotebookController,
    NotebookDocument,
    Uri
} from 'vscode';
import { VSCodeNotebookController, warnWhenUsingOutdatedPython } from './vscodeNotebookController';
import {
    IKernel,
    IKernelProvider,
    INotebookKernelExecution,
    KernelConnectionMetadata,
    LiveRemoteKernelConnectionMetadata,
    LocalKernelConnectionMetadata,
    LocalKernelSpecConnectionMetadata,
    RemoteKernelSpecConnectionMetadata
} from '../../kernels/types';
import { KernelError } from '../../kernels/errors/kernelError';
import { LastCellExecutionTracker } from '../../kernels/execution/lastCellExecutionTracker';
import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito';
import { ITelemetryService } from '../../platform/analytics/types';
import { IEncryptedStorage } from '../../platform/common/application/types';
import {
    IConfigurationService,
    IDisposable,
    IExtensionContext,
    IWatchableJupyterSettings
} from '../../platform/common/types';
import { dispose } from '../../platform/common/utils/lifecycle';
import { ServiceContainer } from '../../platform/ioc/container';
import { NotebookCellLanguageService } from '../languages/cellLanguageService';
import { IServiceContainer } from '../../platform/ioc/types';
import { IJupyterServerProviderRegistry } from '../../kernels/jupyter/types';
import { IPlatformService } from '../../platform/common/platform/types';
import { IPythonExtensionChecker } from '../../platform/api/types';
import { PYTHON_LANGUAGE } from '../../platform/common/constants';
import { TestNotebookDocument } from '../../test/datascience/notebook/executionHelper';
import { KernelConnector } from './kernelConnector';
import { ITrustedKernelPaths } from '../../kernels/raw/finder/types';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IConnectionDisplayData, IConnectionDisplayDataProvider, IVSCodeNotebookController } from './types';
import { ConnectionDisplayDataProvider } from './connectionDisplayData.node';
import { mockedVSCode, mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { Environment, PythonExtension } from '@vscode/python-extension';
import { crateMockedPythonApi, whenResolveEnvironment } from '../../kernels/helpers.unit.test';
import { IJupyterVariablesProvider } from '../../kernels/variables/types';
import { notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { createMockNotebookWithCells } from '../deepnote/deepnoteTestHelpers';

// executeAgentCell takes IEncryptedStorage from the controller's container; getProjectAgentContext
// still resolves the notebook manager off the static one.
function stubAgentDependencies(serviceContainer: IServiceContainer, openAiApiKey: string): void {
    const encryptedStorage = mock<IEncryptedStorage>();
    const staticServiceContainer = instance(mock<ServiceContainer>());

    when(encryptedStorage.retrieve(anything(), anything())).thenResolve(openAiApiKey);
    when(serviceContainer.get<IEncryptedStorage>(IEncryptedStorage)).thenReturn(instance(encryptedStorage));
    sinon.stub(ServiceContainer, 'instance').get(() => staticServiceContainer);
}

function installMockedCreateNotebookController(
    onDidChangeSelectedNotebooksEvent: EventEmitter<{
        readonly notebook: NotebookDocument;
        readonly selected: boolean;
    }>['event'],
    createNotebookCellExecution: NotebookController['createNotebookCellExecution'] = () => ({}) as any
): void {
    (mockedVSCode as any).notebooks.createNotebookController = (
        _id: string,
        _view: string,
        _label: string,
        executeHandler: any,
        _rendererScripts: any
    ) => {
        return {
            id: _id,
            label: _label,
            description: '',
            detail: '',
            supportedLanguages: [],
            supportsExecutionOrder: false,
            interruptHandler: undefined,
            executeHandler,
            onDidChangeSelectedNotebooks: onDidChangeSelectedNotebooksEvent,
            onDidReceiveMessage: new EventEmitter<any>().event,
            dispose: () => {},
            asWebviewUri: (uri: Uri) => uri,
            postMessage: () => Promise.resolve(true),
            updateNotebookAffinity: () => {},
            createNotebookCellExecution,
            createNotebookExecution: () => ({}) as any,
            notebookType: _view,
            rendererScripts: _rendererScripts || []
        } as NotebookController;
    };
}

suite(`Notebook Controller`, function () {
    let controller: NotebookController;
    let kernelConnection: KernelConnectionMetadata;
    let context: IExtensionContext;
    let languageService: NotebookCellLanguageService;
    let configService: IConfigurationService;
    let serviceContainer: IServiceContainer;
    let providerRegistry: IJupyterServerProviderRegistry;
    let platform: IPlatformService;
    let kernelProvider: IKernelProvider;
    let extensionChecker: IPythonExtensionChecker;
    let disposables: IDisposable[] = [];
    let onDidChangeSelectedNotebooks: EventEmitter<{
        readonly notebook: NotebookDocument;
        readonly selected: boolean;
    }>;
    let kernel: IKernel;
    let onDidCloseNotebookDocument: EventEmitter<NotebookDocument>;
    let notebook: TestNotebookDocument;
    let clock: fakeTimers.InstalledClock;
    let jupyterSettings: IWatchableJupyterSettings;
    let trustedPaths: ITrustedKernelPaths;
    let displayDataProvider: IConnectionDisplayDataProvider;
    let interpreterService: IInterpreterService;
    setup(async function () {
        resetVSCodeMocks();
        disposables.push(new Disposable(() => resetVSCodeMocks()));
        kernelConnection = mock<KernelConnectionMetadata>();
        context = mock<IExtensionContext>();
        languageService = mock<NotebookCellLanguageService>();
        configService = mock<IConfigurationService>();
        serviceContainer = mock<IServiceContainer>();
        providerRegistry = mock<IJupyterServerProviderRegistry>();
        platform = mock<IPlatformService>();
        kernelProvider = mock<IKernelProvider>();
        extensionChecker = mock<IPythonExtensionChecker>();
        controller = mock<NotebookController>();
        kernel = mock<IKernel>();
        onDidChangeSelectedNotebooks = new EventEmitter<{
            readonly notebook: NotebookDocument;
            readonly selected: boolean;
        }>();
        jupyterSettings = mock<IWatchableJupyterSettings>();
        trustedPaths = mock<ITrustedKernelPaths>();
        interpreterService = mock<IInterpreterService>();
        const onDidChangeInterpreters = new EventEmitter<PythonEnvironment[]>();
        when(interpreterService.onDidChangeInterpreters).thenReturn(onDidChangeInterpreters.event);
        onDidCloseNotebookDocument = new EventEmitter<NotebookDocument>();
        disposables.push(onDidChangeSelectedNotebooks);
        disposables.push(onDidChangeInterpreters);
        disposables.push(onDidCloseNotebookDocument);
        clock = fakeTimers.install();
        disposables.push(new Disposable(() => clock.uninstall()));
        when(context.extensionUri).thenReturn(Uri.file('extension'));
        when(controller.onDidChangeSelectedNotebooks).thenReturn(onDidChangeSelectedNotebooks.event);
        when(controller.id).thenReturn('test-controller-id');
        when(controller.label).thenReturn('Test Controller');
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);
        when(mockedVSCodeNamespaces.workspace.onDidCloseNotebookDocument).thenReturn(onDidCloseNotebookDocument.event);
        installMockedCreateNotebookController(onDidChangeSelectedNotebooks.event);
        when(languageService.getSupportedLanguages(anything())).thenReturn([PYTHON_LANGUAGE]);
        when(mockedVSCodeNamespaces.workspace.isTrusted).thenReturn(true);
        when(mockedVSCodeNamespaces.workspace.onDidCloseNotebookDocument).thenReturn(onDidCloseNotebookDocument.event);
        when(mockedVSCodeNamespaces.window.visibleNotebookEditors).thenReturn([]);
        when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenResolve();
        when(kernelProvider.getOrCreate(anything(), anything())).thenReturn(instance(kernel));
        when(configService.getSettings(anything())).thenReturn(instance(jupyterSettings));
        when((kernelConnection as LocalKernelConnectionMetadata).kernelSpec).thenReturn({
            argv: [],
            executable: '',
            name: '',
            display_name: '',
            specFile: '1'
        });
        when(extensionChecker.isPythonExtensionInstalled).thenReturn(true);
        when(kernel.kernelConnectionMetadata).thenReturn(instance(kernelConnection));
        when(kernelConnection.id).thenReturn('1');
        when(serviceContainer.get<ITrustedKernelPaths>(ITrustedKernelPaths)).thenReturn(instance(trustedPaths));
        when(trustedPaths.isTrusted(anything())).thenReturn(true);
        when(jupyterSettings.disableJupyterAutoStart).thenReturn(false);
        displayDataProvider = new ConnectionDisplayDataProvider(
            instance(platform),
            instance(providerRegistry),
            disposables,
            instance(interpreterService)
        );
    });
    teardown(() => (disposables = dispose(disposables)));
    function createController(viewType: 'jupyter-notebook' | 'interactive') {
        new VSCodeNotebookController(
            instance(kernelConnection),
            '1',
            viewType,
            instance(kernelProvider),
            instance(context),
            disposables,
            instance(languageService),
            instance(configService),
            instance(extensionChecker),
            instance(serviceContainer),
            displayDataProvider
        );
        notebook = new TestNotebookDocument(undefined, viewType);
    }
    test('Kernel is created upon selecting a controller', async function () {
        createController('jupyter-notebook');
        when(kernelProvider.get(notebook)).thenReturn();

        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).once();
    });
    test('Kernel is not created upon selecting a controller if workspace is not trusted', async function () {
        createController('jupyter-notebook');
        when(kernelProvider.get(notebook)).thenReturn();
        when(mockedVSCodeNamespaces.workspace.isTrusted).thenReturn(false);

        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).never();
    });
    test('Kernel is auto started upon selecting a local controller', async function () {
        createController('jupyter-notebook');
        when(kernelConnection.kind).thenReturn('startUsingLocalKernelSpec');
        when(kernelProvider.get(notebook)).thenReturn();

        const oldConnectToNotebook = KernelConnector.connectToNotebookKernel;
        let kernelStarted = false;
        KernelConnector.connectToNotebookKernel = async () => {
            kernelStarted = true;
            return instance(kernel);
        };
        disposables.push(new Disposable(() => (KernelConnector.connectToNotebookKernel = oldConnectToNotebook)));
        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).once();
        assert.isTrue(kernelStarted, 'Kernel not started');
    });
    test('Kernel is not auto started upon selecting a local controller if kernel path is not trusted', async function () {
        createController('jupyter-notebook');
        when(kernelConnection.kind).thenReturn('startUsingLocalKernelSpec');
        when(kernelProvider.get(notebook)).thenReturn();
        when(trustedPaths.isTrusted(anything())).thenReturn(false);

        const oldConnectToNotebook = KernelConnector.connectToNotebookKernel;
        let kernelStarted = false;
        KernelConnector.connectToNotebookKernel = async () => {
            kernelStarted = true;
            return instance(kernel);
        };
        disposables.push(new Disposable(() => (KernelConnector.connectToNotebookKernel = oldConnectToNotebook)));
        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).once();
        assert.isFalse(kernelStarted, 'Kernel should not have been started');
    });
    test('Kernel is not auto started upon selecting a local controller if auto start is disabled', async function () {
        createController('jupyter-notebook');
        when(kernelConnection.kind).thenReturn('startUsingLocalKernelSpec');
        when(kernelProvider.get(notebook)).thenReturn();
        when(jupyterSettings.disableJupyterAutoStart).thenReturn(true);

        const oldConnectToNotebook = KernelConnector.connectToNotebookKernel;
        let kernelStarted = false;
        KernelConnector.connectToNotebookKernel = async () => {
            kernelStarted = true;
            return instance(kernel);
        };
        disposables.push(new Disposable(() => (KernelConnector.connectToNotebookKernel = oldConnectToNotebook)));
        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).once();
        assert.isFalse(kernelStarted, 'Kernel should not have been started');
    });
    test('Kernel is not auto started upon selecting a remote kernelspec controller', async function () {
        createController('jupyter-notebook');
        when(kernelConnection.kind).thenReturn('startUsingRemoteKernelSpec');
        when(kernelProvider.get(notebook)).thenReturn();

        const oldConnectToNotebook = KernelConnector.connectToNotebookKernel;
        let kernelStarted = false;
        KernelConnector.connectToNotebookKernel = async () => {
            kernelStarted = true;
            return instance(kernel);
        };
        disposables.push(new Disposable(() => (KernelConnector.connectToNotebookKernel = oldConnectToNotebook)));
        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).once();
        assert.isFalse(kernelStarted, 'Kernel should not have been started');
    });
    test('Kernel is not auto started upon selecting a remote live kernel controller', async function () {
        createController('jupyter-notebook');
        when(kernelConnection.kind).thenReturn('connectToLiveRemoteKernel');
        when(kernelProvider.get(notebook)).thenReturn();

        const oldConnectToNotebook = KernelConnector.connectToNotebookKernel;
        let kernelStarted = false;
        KernelConnector.connectToNotebookKernel = async () => {
            kernelStarted = true;
            return instance(kernel);
        };
        disposables.push(new Disposable(() => (KernelConnector.connectToNotebookKernel = oldConnectToNotebook)));
        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(kernelProvider.getOrCreate(anything(), anything())).once();
        assert.isFalse(kernelStarted, 'Kernel should not have been started');
    });
    test('Update notebook metadata upon selecting a controller', async function () {
        createController('jupyter-notebook');
        when(kernelConnection.kind).thenReturn('connectToLiveRemoteKernel');
        when(kernelProvider.get(notebook)).thenReturn();
        when(jupyterSettings.disableJupyterAutoStart).thenReturn(true);

        onDidChangeSelectedNotebooks.fire({ notebook, selected: true });
        await clock.runAllAsync();

        verify(mockedVSCodeNamespaces.workspace.applyEdit(anything())).once();
    });
    suite('Unsupported Python Versions', () => {
        let disposables: IDisposable[] = [];
        let environments: PythonExtension['environments'];
        setup(() => {
            environments = crateMockedPythonApi(disposables).environments;
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).thenResolve(undefined);
        });
        teardown(() => {
            disposables = dispose(disposables);
            resetVSCodeMocks();
        });
        test('No warnings when Python is not used', async () => {
            const kernels = [
                RemoteKernelSpecConnectionMetadata.create({
                    baseUrl: 'http://localhost:8888/',
                    id: '1234',
                    kernelSpec: {
                        argv: [],
                        display_name: '',
                        executable: '',
                        name: ''
                    },
                    serverProviderHandle: {
                        extensionId: '',
                        handle: '',
                        id: ''
                    }
                }),
                LiveRemoteKernelConnectionMetadata.create({
                    baseUrl: 'http://localhost:8888/',
                    id: '1234',
                    kernelModel: {
                        name: '',
                        lastActivityTime: '',
                        model: undefined,
                        numberOfConnections: 1
                    },
                    serverProviderHandle: {
                        extensionId: '',
                        handle: '',
                        id: ''
                    }
                }),
                LocalKernelSpecConnectionMetadata.create({
                    id: '1234',
                    kernelSpec: {
                        argv: [],
                        display_name: '',
                        executable: '',
                        name: ''
                    }
                })
            ];

            for (const kernel of kernels) {
                await warnWhenUsingOutdatedPython(kernel);
                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).never();
            }
        });
        const validVersionsOfPython: Environment['version'][] = [
            {
                major: 3,
                minor: 6,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 3,
                minor: 7,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 3,
                minor: 8,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 3,
                minor: 12,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 4,
                minor: 0,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            }
        ];

        validVersionsOfPython.forEach((version) => {
            test(`No warnings when Python version is valid ${version?.major}.${version?.minor}.${version?.micro}`, async () => {
                const kernel = LocalKernelSpecConnectionMetadata.create({
                    id: '1234',
                    kernelSpec: {
                        argv: [],
                        display_name: '',
                        executable: '',
                        name: ''
                    },
                    interpreter: {
                        id: 'version',
                        uri: Uri.file('')
                    }
                });
                when(environments.known).thenReturn([
                    {
                        environment: {
                            folderUri: Uri.file(''),
                            name: '',
                            type: '',
                            workspaceFolder: undefined
                        },
                        executable: {
                            bitness: undefined,
                            sysPrefix: undefined,
                            uri: undefined
                        },
                        id: 'version',
                        path: '',
                        tools: [],
                        version
                    }
                ]);
                await warnWhenUsingOutdatedPython(kernel);
                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).never();
            });
        });
        const invalidVersionsOfPython: Environment['version'][] = [
            {
                major: 3,
                minor: -6,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: -3,
                minor: 7,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: -1,
                minor: 8,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 0,
                minor: 0,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 0,
                minor: 1,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            }
        ];

        invalidVersionsOfPython.forEach((version) => {
            test(`No warnings when Python version is invalid ${version?.major}.${version?.minor}.${version?.micro}`, async () => {
                const kernel = LocalKernelSpecConnectionMetadata.create({
                    id: '1234',
                    kernelSpec: {
                        argv: [],
                        display_name: '',
                        executable: '',
                        name: ''
                    },
                    interpreter: {
                        id: 'version',
                        uri: Uri.file('')
                    }
                });
                when(environments.known).thenReturn([
                    {
                        environment: {
                            folderUri: Uri.file(''),
                            name: '',
                            type: '',
                            workspaceFolder: undefined
                        },
                        executable: {
                            bitness: undefined,
                            sysPrefix: undefined,
                            uri: undefined
                        },
                        id: 'version',
                        path: '',
                        tools: [],
                        version
                    }
                ]);
                await warnWhenUsingOutdatedPython(kernel);
                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).never();
            });
        });
        const unsupportedVersionsOfPython: Environment['version'][] = [
            {
                major: 3,
                minor: 5,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 3,
                minor: 4,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 2,
                minor: 7,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            },
            {
                major: 2,
                minor: 5,
                micro: 0,
                release: undefined,
                sysVersion: undefined
            }
        ];

        unsupportedVersionsOfPython.forEach((version) => {
            test(`Warnings when Python version is not supported ${version?.major}.${version?.minor}.${version?.micro}`, async () => {
                const kernel = LocalKernelSpecConnectionMetadata.create({
                    id: '1234',
                    kernelSpec: {
                        argv: [],
                        display_name: '',
                        executable: '',
                        name: ''
                    },
                    interpreter: {
                        id: 'version',
                        uri: Uri.file('')
                    }
                });
                whenResolveEnvironment(environments).thenResolve({
                    id: 'version',
                    version
                });
                await warnWhenUsingOutdatedPython(kernel);
                verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything())).once();
            });
        });
    });

    suite('VSCodeNotebookController.create', function () {
        let kernelConnection: KernelConnectionMetadata;
        let kernelProvider: IKernelProvider;
        let context: IExtensionContext;
        let languageService: NotebookCellLanguageService;
        let configService: IConfigurationService;
        let extensionChecker: IPythonExtensionChecker;
        let serviceContainer: IServiceContainer;
        let displayDataProvider: IConnectionDisplayDataProvider;
        let jupyterVariablesProvider: IJupyterVariablesProvider;
        let disposables: IDisposable[] = [];
        let controller: NotebookController;
        let onDidChangeSelectedNotebooks: EventEmitter<{
            readonly notebook: NotebookDocument;
            readonly selected: boolean;
        }>;

        setup(function () {
            resetVSCodeMocks();
            disposables.push(new Disposable(() => resetVSCodeMocks()));
            kernelConnection = mock<KernelConnectionMetadata>();
            kernelProvider = mock<IKernelProvider>();
            context = mock<IExtensionContext>();
            languageService = mock<NotebookCellLanguageService>();
            configService = mock<IConfigurationService>();
            extensionChecker = mock<IPythonExtensionChecker>();
            serviceContainer = mock<IServiceContainer>();
            displayDataProvider = mock<IConnectionDisplayDataProvider>();
            jupyterVariablesProvider = mock<IJupyterVariablesProvider>();
            controller = mock<NotebookController>();
            onDidChangeSelectedNotebooks = new EventEmitter<{
                readonly notebook: NotebookDocument;
                readonly selected: boolean;
            }>();
            disposables.push(onDidChangeSelectedNotebooks);

            when(context.extensionUri).thenReturn(Uri.file('extension'));
            when(controller.onDidChangeSelectedNotebooks).thenReturn(onDidChangeSelectedNotebooks.event);
            when(controller.id).thenReturn('test-controller-id');
            when(controller.label).thenReturn('Test Controller');
            when(displayDataProvider.getDisplayData(anything())).thenReturn({
                label: 'Test Kernel',
                description: 'Test Description',
                detail: 'Test Detail',
                category: 'Test Category',
                serverDisplayName: 'Test Server',
                onDidChange: new EventEmitter<IConnectionDisplayData>().event,
                dispose: () => {
                    /* noop */
                }
            });
            when(
                mockedVSCodeNamespaces.notebooks.createNotebookController(
                    anything(),
                    anything(),
                    anything(),
                    anything(),
                    anything()
                )
            ).thenCall((_id, _view, _label, _handler, _rendererScripts) => {
                // Create a plain object with all required controller properties
                const mockController = {
                    id: _id,
                    label: _label,
                    description: '',
                    detail: '',
                    supportedLanguages: [],
                    supportsExecutionOrder: false,
                    interruptHandler: undefined,
                    executeHandler: _handler,
                    onDidChangeSelectedNotebooks: onDidChangeSelectedNotebooks.event,
                    onDidReceiveMessage: new EventEmitter<any>().event,
                    dispose: () => {},
                    asWebviewUri: (uri: Uri) => uri,
                    postMessage: () => Promise.resolve(true),
                    updateNotebookAffinity: () => {},
                    createNotebookCellExecution: () => ({}) as any,
                    createNotebookExecution: () => ({}) as any,
                    notebookType: _view,
                    rendererScripts: _rendererScripts || []
                };
                return mockController as NotebookController;
            });
        });

        teardown(() => (disposables = dispose(disposables)));

        test('Should attach variable provider when API is available', function () {
            // Arrange: Mock controller with variableProvider property
            when(
                mockedVSCodeNamespaces.notebooks.createNotebookController(
                    anything(),
                    anything(),
                    anything(),
                    anything(),
                    anything()
                )
            ).thenCall((_id, _view, _label, _handler, _rendererScripts) => {
                const mockController: any = {
                    id: _id,
                    label: _label,
                    description: '',
                    detail: '',
                    supportedLanguages: [],
                    supportsExecutionOrder: false,
                    interruptHandler: undefined,
                    executeHandler: _handler,
                    onDidChangeSelectedNotebooks: onDidChangeSelectedNotebooks.event,
                    onDidReceiveMessage: new EventEmitter<any>().event,
                    dispose: () => {},
                    asWebviewUri: (uri: Uri) => uri,
                    postMessage: () => Promise.resolve(true),
                    updateNotebookAffinity: () => {},
                    createNotebookCellExecution: () => ({}) as any,
                    createNotebookExecution: () => ({}) as any,
                    notebookType: _view,
                    rendererScripts: _rendererScripts || [],
                    variableProvider: undefined
                };
                return mockController as NotebookController;
            });

            // Act
            const result = VSCodeNotebookController.create(
                instance(kernelConnection),
                'test-id',
                'jupyter-notebook',
                instance(kernelProvider),
                instance(context),
                disposables,
                instance(languageService),
                instance(configService),
                instance(extensionChecker),
                instance(serviceContainer),
                instance(displayDataProvider),
                instance(jupyterVariablesProvider)
            );

            // Assert
            assert.isDefined(result);
            assert.strictEqual(
                (result.controller as any).variableProvider,
                instance(jupyterVariablesProvider),
                'Variable provider should be attached when API is available'
            );
        });

        test('Should not attach variable provider when API is not available', function () {
            // Arrange: Create a plain object without variableProvider property
            const controllerWithoutApi = {
                onDidChangeSelectedNotebooks: onDidChangeSelectedNotebooks.event,
                id: 'test-id',
                notebookType: 'jupyter-notebook',
                supportedLanguages: [],
                supportsExecutionOrder: true,
                description: '',
                detail: '',
                label: 'Test Kernel',
                dispose: () => {
                    /* noop */
                },
                createNotebookCellExecution: () => ({}) as any,
                createNotebookExecution: () => ({}) as any,
                executeHandler: () => {
                    /* noop */
                },
                interruptHandler: undefined,
                updateNotebookAffinity: () => {
                    /* noop */
                },
                rendererScripts: [],
                onDidReceiveMessage: new EventEmitter<any>().event,
                postMessage: () => Promise.resolve(true),
                asWebviewUri: (uri: Uri) => uri
                // Note: no variableProvider property to simulate API not being available
            } as NotebookController;

            when(
                mockedVSCodeNamespaces.notebooks.createNotebookController(
                    anything(),
                    anything(),
                    anything(),
                    anything(),
                    anything()
                )
            ).thenReturn(controllerWithoutApi);

            // Act
            const result = VSCodeNotebookController.create(
                instance(kernelConnection),
                'test-id',
                'jupyter-notebook',
                instance(kernelProvider),
                instance(context),
                disposables,
                instance(languageService),
                instance(configService),
                instance(extensionChecker),
                instance(serviceContainer),
                instance(displayDataProvider),
                instance(jupyterVariablesProvider)
            );

            // Assert
            assert.isDefined(result);
            assert.isFalse(
                'variableProvider' in result.controller,
                'Variable provider property should not exist when API is not available'
            );
        });

        test('Should handle errors when attaching variable provider', function () {
            // Arrange: Mock controller that throws when setting variableProvider
            const controllerWithError = mock<NotebookController>();
            when(controllerWithError.onDidChangeSelectedNotebooks).thenReturn(onDidChangeSelectedNotebooks.event);

            const controllerInstance = instance(controllerWithError);
            Object.defineProperty(controllerInstance, 'variableProvider', {
                set: () => {
                    throw new Error('API not supported');
                },
                configurable: true
            });

            when(
                mockedVSCodeNamespaces.notebooks.createNotebookController(
                    anything(),
                    anything(),
                    anything(),
                    anything(),
                    anything()
                )
            ).thenReturn(controllerInstance);

            // Act - should not throw
            const result = VSCodeNotebookController.create(
                instance(kernelConnection),
                'test-id',
                'jupyter-notebook',
                instance(kernelProvider),
                instance(context),
                disposables,
                instance(languageService),
                instance(configService),
                instance(extensionChecker),
                instance(serviceContainer),
                instance(displayDataProvider),
                instance(jupyterVariablesProvider)
            );

            // Assert
            assert.isDefined(result);
        });

        suite('execute_notebook telemetry', () => {
            let telemetry: ITelemetryService;

            function createControllerForExecution(): IVSCodeNotebookController {
                return VSCodeNotebookController.create(
                    instance(kernelConnection),
                    'test-id',
                    'jupyter-notebook',
                    instance(kernelProvider),
                    instance(context),
                    disposables,
                    instance(languageService),
                    instance(configService),
                    instance(extensionChecker),
                    instance(serviceContainer),
                    instance(displayDataProvider),
                    instance(jupyterVariablesProvider)
                );
            }

            function codeCell(index: number): NotebookCell {
                return { index, kind: NotebookCellKind.Code, document: { getText: () => '' } } as never;
            }

            function markdownCell(index: number): NotebookCell {
                return { index, kind: NotebookCellKind.Markup, document: { getText: () => '' } } as never;
            }

            function deepnoteNotebook(cells: NotebookCell[]): NotebookDocument {
                return { notebookType: 'deepnote', uri: Uri.file('/ws/exec.deepnote'), getCells: () => cells } as never;
            }

            setup(() => {
                telemetry = mock<ITelemetryService>();
                when(mockedVSCodeNamespaces.workspace.isTrusted).thenReturn(true);
                when(serviceContainer.get<ITelemetryService>(ITelemetryService)).thenReturn(instance(telemetry));
            });

            async function handleExecution(cells: NotebookCell[], notebook: NotebookDocument): Promise<void> {
                // Kernel startup after the tracking point fails on these bare mocks; that failure is
                // irrelevant to what these tests assert.
                await (createControllerForExecution() as any).handleExecution(cells, notebook).catch(() => undefined);
            }

            test('a batch covering every code cell reports execute_notebook', async () => {
                const cells = [codeCell(0), codeCell(1)];
                const notebook = deepnoteNotebook([...cells, markdownCell(2)]);

                await handleExecution(cells, notebook);

                verify(telemetry.trackEvent(deepEqual({ eventName: 'execute_notebook' }))).once();
                verify(telemetry.trackEvent(anything())).once();
            });

            test('a partial batch or a non-Deepnote notebook does not report execute_notebook', async () => {
                const allCells = [codeCell(0), codeCell(1)];

                await handleExecution([allCells[0]], deepnoteNotebook(allCells));
                await handleExecution(allCells, {
                    notebookType: 'jupyter-notebook',
                    uri: Uri.file('/ws/n.ipynb'),
                    getCells: () => allCells
                } as never as NotebookDocument);

                verify(telemetry.trackEvent(anything())).never();
            });
        });
    });

    suite('executeQueuedCells', function () {
        let vscodeController: VSCodeNotebookController;
        let notifyQueueCompleteSpy: sinon.SinonSpy;
        let createNotebookCellExecutionStub: sinon.SinonStub;
        let mockExecution: {
            appendOutput: sinon.SinonStub;
            clearOutput: sinon.SinonStub;
            end: sinon.SinonStub;
            replaceOutput: sinon.SinonStub;
            appendOutputItems: sinon.SinonStub;
            start: sinon.SinonStub;
            token: { isCancellationRequested: boolean };
        };

        setup(function () {
            crateMockedPythonApi(disposables);
            stubAgentDependencies(serviceContainer, 'test-key');
            when(serviceContainer.tryGet(anything())).thenReturn(undefined);
            // handleExecution reports execute_notebook whenever the batch covers every code cell,
            // which an agent-only batch does; these tests assert on the queue, not on telemetry.
            when(serviceContainer.get<ITelemetryService>(ITelemetryService)).thenReturn(
                instance(mock<ITelemetryService>())
            );

            mockExecution = {
                appendOutput: sinon.stub().resolves(),
                clearOutput: sinon.stub().resolves(),
                end: sinon.stub(),
                replaceOutput: sinon.stub().resolves(),
                appendOutputItems: sinon.stub().resolves(),
                start: sinon.stub(),
                token: { isCancellationRequested: false }
            };
            createNotebookCellExecutionStub = sinon.stub().callsFake(() => {
                mockExecution.end = sinon.stub();

                return mockExecution;
            });

            installMockedCreateNotebookController(onDidChangeSelectedNotebooks.event, createNotebookCellExecutionStub);

            notifyQueueCompleteSpy = sinon.spy(notebookCellExecutions, 'notifyQueueComplete');

            vscodeController = new VSCodeNotebookController(
                instance(kernelConnection),
                'test-controller-id',
                'jupyter-notebook',
                instance(kernelProvider),
                instance(context),
                disposables,
                instance(languageService),
                instance(configService),
                instance(extensionChecker),
                instance(serviceContainer),
                displayDataProvider
            );
        });

        teardown(function () {
            notifyQueueCompleteSpy.restore();
            sinon.restore();
        });

        // The connected kernel is a plain object, not `instance(mock<IKernel>())`: a ts-mockito proxy
        // answers `then` with a function, so awaiting the connect promise would never settle.
        // Anything left unstubbed throws inside the per-cell try and would abort the batch for the wrong reason.
        function stubKernelForExecution(kernelExecution: Partial<INotebookKernelExecution>): void {
            const neverFires = () => new Disposable(() => undefined);
            const connectedKernel = {
                controller: {
                    id: 'test-controller-id',
                    createNotebookCellExecution: (cell: NotebookCell) =>
                        vscodeController.controller.createNotebookCellExecution(cell)
                },
                disposing: false,
                onDisposed: neverFires,
                onStatusChanged: neverFires
            } as unknown as IKernel;

            const oldConnectToNotebook = KernelConnector.connectToNotebookKernel;
            KernelConnector.connectToNotebookKernel = async () => connectedKernel;
            disposables.push(new Disposable(() => (KernelConnector.connectToNotebookKernel = oldConnectToNotebook)));

            when(serviceContainer.get<LastCellExecutionTracker>(LastCellExecutionTracker)).thenReturn(
                instance(mock<LastCellExecutionTracker>())
            );
            when(kernelProvider.getKernelExecution(anything())).thenReturn(kernelExecution as INotebookKernelExecution);
        }

        test('a failed kernel segment stops the agent cell and the trailing segment', async function () {
            // Catches: executeKernelCells swallowing a KernelError, so Run All continues past a failed cell.
            const {
                notebook,
                cells: [failingCell, agentCell, trailingCell]
            } = createMockNotebookWithCells([
                { metadata: { id: 'code-1' }, text: 'raise ValueError()' },
                { metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' }, text: 'Test prompt' },
                { metadata: { id: 'code-2' }, text: 'print(2)' }
            ]);

            const executedIndexes: number[] = [];
            stubKernelForExecution({
                failed: false,
                executeCell: async (cell: NotebookCell) => {
                    executedIndexes.push(cell.index);
                    throw new KernelError({ ename: 'ValueError', evalue: 'boom', traceback: [] });
                }
            });

            await vscodeController.controller.executeHandler(
                [failingCell, agentCell, trailingCell],
                notebook,
                vscodeController.controller
            );

            assert.deepStrictEqual(executedIndexes, [0], 'the trailing segment must not run after a failure');
            assert.isFalse(
                createNotebookCellExecutionStub.getCalls().some((call) => call.args[0] === agentCell),
                'the agent cell must not start after a failed segment'
            );
        });

        test('an interrupted kernel segment stops the agent cell even though its cells resolve', async function () {
            // Catches: relying on a rejection alone - cancelled cell executions resolve
            // (CellExecution.completedDueToCancellation), so only the queue's verdict shows the interrupt.
            const {
                notebook,
                cells: [interruptedCell, agentCell, trailingCell]
            } = createMockNotebookWithCells([
                { metadata: { id: 'code-1' }, text: 'time.sleep(30)' },
                { metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' }, text: 'Test prompt' },
                { metadata: { id: 'code-2' }, text: 'print(2)' }
            ]);

            const executedIndexes: number[] = [];
            stubKernelForExecution({
                failed: true,
                executeCell: async (cell: NotebookCell) => {
                    executedIndexes.push(cell.index);
                }
            });

            await vscodeController.controller.executeHandler(
                [interruptedCell, agentCell, trailingCell],
                notebook,
                vscodeController.controller
            );

            assert.deepStrictEqual(executedIndexes, [0], 'the trailing segment must not run after an interrupt');
            assert.isFalse(
                createNotebookCellExecutionStub.getCalls().some((call) => call.args[0] === agentCell),
                'the agent cell must not start after an interrupt'
            );
        });

        test('a clean kernel segment still runs the agent cell and the trailing segment', async function () {
            // Catches: aborting the batch when nothing failed (e.g. consulting the queue verdict too early).
            const {
                notebook,
                cells: [firstCell, agentCell, trailingCell]
            } = createMockNotebookWithCells([
                { metadata: { id: 'code-1' }, text: 'x = 1' },
                { metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' }, text: 'Test prompt' },
                { metadata: { id: 'code-2' }, text: 'print(2)' }
            ]);

            const executedIndexes: number[] = [];
            stubKernelForExecution({
                failed: false,
                executeCell: async (cell: NotebookCell) => {
                    executedIndexes.push(cell.index);
                }
            });

            await vscodeController.controller.executeHandler(
                [firstCell, agentCell, trailingCell],
                notebook,
                vscodeController.controller
            );

            assert.deepStrictEqual(executedIndexes, [0, 2], 'both kernel segments must run when nothing failed');
            assert.isTrue(
                createNotebookCellExecutionStub.getCalls().some((call) => call.args[0] === agentCell),
                'the agent cell must run between the segments'
            );
        });

        test('agent-only batch fires notifyQueueComplete (arms deferred snapshot save)', async function () {
            // Catches: agent-only runs never reach CellExecutionQueue, so snapshot save never arms.
            const {
                notebook: agentNotebook,
                cells: [agentCell]
            } = createMockNotebookWithCells([
                {
                    metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' },
                    text: 'Test prompt'
                }
            ]);

            const notebookUri = agentNotebook.uri.toString();

            let queueCompletionUri: string | undefined;
            const queueListener = notebookCellExecutions.onDidCompleteQueueExecution((event) => {
                queueCompletionUri = event.notebookUri;
            });
            disposables.push(new Disposable(() => queueListener.dispose()));

            const executeHandler = vscodeController.controller.executeHandler;
            assert.isDefined(executeHandler);

            await executeHandler([agentCell], agentNotebook, vscodeController.controller);

            assert.isTrue(notifyQueueCompleteSpy.calledOnce, 'notifyQueueComplete must run after agent-only execution');
            assert.strictEqual(notifyQueueCompleteSpy.firstCall.args[0], notebookUri);
            assert.strictEqual(queueCompletionUri, notebookUri);
            assert.isTrue(createNotebookCellExecutionStub.calledOnce, 'agent cell should run through executeAgentCell');
        });

        test('an agent batch and a later kernel-only batch each fire exactly one completion', async function () {
            // Catches: tying completion to an "this batch ran an agent cell" flag — CellExecutionQueue no
            // longer notifies, so a plain Run would arm no deferred snapshot save.
            const {
                notebook: agentNotebook,
                cells: [agentCell, codeCell]
            } = createMockNotebookWithCells([
                {
                    metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' },
                    text: 'Test prompt'
                },
                {
                    metadata: { id: 'code-1' },
                    text: 'print(1)'
                }
            ]);

            stubKernelForExecution({ failed: false, executeCell: async () => undefined });

            await vscodeController.controller.executeHandler([agentCell], agentNotebook, vscodeController.controller);
            await vscodeController.controller.executeHandler([codeCell], agentNotebook, vscodeController.controller);

            assert.deepStrictEqual(
                notifyQueueCompleteSpy.getCalls().map((call) => call.args[0]),
                [agentNotebook.uri.toString(), agentNotebook.uri.toString()],
                'each gesture fires one completion for its own notebook'
            );
        });

        test('a kernel-only batch fires the completion itself', async function () {
            // Catches: leaving completion to CellExecutionQueue, which no longer announces it — the
            // deferred snapshot save would never arm for an ordinary run.
            const {
                notebook: codeNotebook,
                cells: [codeCell]
            } = createMockNotebookWithCells([
                {
                    metadata: { id: 'code-block-1' },
                    text: 'x = 1'
                }
            ]);

            stubKernelForExecution({ failed: false, executeCell: async () => undefined });

            await vscodeController.controller.executeHandler([codeCell], codeNotebook, vscodeController.controller);

            assert.isTrue(notifyQueueCompleteSpy.calledOnce, 'a kernel-only batch must fire one completion');
            assert.strictEqual(notifyQueueCompleteSpy.firstCall.args[0], codeNotebook.uri.toString());
        });

        test('a run that re-enters once per generated cell fires exactly one completion', async function () {
            // Catches the N+1 snapshot saves an agent run produced: each generated cell is dispatched
            // through `notebook.cell.execute`, which lands back in this handler while the outer batch is
            // still in flight. Completion belongs to the gesture, not to every nested run.
            const {
                notebook,
                cells: [runCell, generatedFirst, generatedSecond]
            } = createMockNotebookWithCells([
                { metadata: { id: 'code-1' }, text: 'x = 1' },
                { metadata: { id: 'generated-1' }, text: 'print(1)' },
                { metadata: { id: 'generated-2' }, text: 'print(2)' }
            ]);

            const executedIds: string[] = [];
            stubKernelForExecution({
                failed: false,
                executeCell: async (cell: NotebookCell) => {
                    executedIds.push(cell.metadata.id as string);

                    if (cell !== runCell) {
                        return;
                    }

                    await vscodeController.controller.executeHandler(
                        [generatedFirst],
                        notebook,
                        vscodeController.controller
                    );
                    await vscodeController.controller.executeHandler(
                        [generatedSecond],
                        notebook,
                        vscodeController.controller
                    );
                }
            });

            await vscodeController.controller.executeHandler([runCell], notebook, vscodeController.controller);

            assert.deepStrictEqual(
                executedIds,
                ['code-1', 'generated-1', 'generated-2'],
                'both re-entrant runs must have executed'
            );
            assert.strictEqual(
                notifyQueueCompleteSpy.callCount,
                1,
                'the gesture owns the completion; the runs nested inside it must not fire their own'
            );
        });

        test('a batch that fails still fires its own completion and does not silence the next one', async function () {
            // Catches: skipping the completion when the batch unwinds — an interrupted run must still
            // snapshot what it produced, and must not leave the re-entrancy depth above zero.
            const {
                notebook,
                cells: [failingCell, laterCell]
            } = createMockNotebookWithCells([
                { metadata: { id: 'code-1' }, text: 'raise ValueError()' },
                { metadata: { id: 'code-2' }, text: 'x = 1' }
            ]);

            stubKernelForExecution({
                failed: false,
                executeCell: async (cell: NotebookCell) => {
                    if (cell === failingCell) {
                        throw new KernelError({ ename: 'ValueError', evalue: 'boom', traceback: [] });
                    }
                }
            });

            await vscodeController.controller.executeHandler([failingCell], notebook, vscodeController.controller);
            await vscodeController.controller.executeHandler([laterCell], notebook, vscodeController.controller);

            assert.strictEqual(notifyQueueCompleteSpy.callCount, 2, 'a failed batch must not silence later runs');
        });

        test('a rejected scratch-cell cleanup neither escapes nor strands the completion', async function () {
            // Catches: clearing prior scratch cells outside the frame that owns the re-entrancy depth —
            // a rejected workspace edit would escape before the depth is handed back, silencing every
            // completion for the rest of the session.
            const {
                notebook,
                cells: [agentCell, , laterCell]
            } = createMockNotebookWithCells([
                { metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' }, text: 'Test prompt' },
                {
                    metadata: { agent_source_block_id: 'agent-block-1', id: 'scratch-1', is_ephemeral: true },
                    text: 'print(1)'
                },
                { metadata: { id: 'code-1' }, text: 'x = 1' }
            ]);

            stubKernelForExecution({ failed: false, executeCell: async () => undefined });
            when(mockedVSCodeNamespaces.workspace.applyEdit(anything())).thenReject(new Error('edit failed'));

            let escaped: unknown;

            try {
                await vscodeController.controller.executeHandler([agentCell], notebook, vscodeController.controller);
            } catch (ex) {
                escaped = ex;
            }

            await vscodeController.controller.executeHandler([laterCell], notebook, vscodeController.controller);

            assert.isUndefined(escaped, 'a rejected cleanup edit must not escape the execute handler');
            assert.strictEqual(notifyQueueCompleteSpy.callCount, 2, 'a cleanup failure must not strand the depth');
        });
    });
});
