// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable no-void */
/* eslint-disable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import * as sinon from 'sinon';
import { Disposable, EventEmitter, NotebookController, NotebookDocument, Uri } from 'vscode';
import { VSCodeNotebookController, warnWhenUsingOutdatedPython } from './vscodeNotebookController';
import {
    IKernel,
    IKernelProvider,
    KernelConnectionMetadata,
    LiveRemoteKernelConnectionMetadata,
    LocalKernelConnectionMetadata,
    LocalKernelSpecConnectionMetadata,
    RemoteKernelSpecConnectionMetadata
} from '../../kernels/types';
import { anything, instance, mock, verify, when } from 'ts-mockito';
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
import { IConnectionDisplayData, IConnectionDisplayDataProvider } from './types';
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

        test('kernel-only batch after agent batch does not fire a second explicit queue completion notify', async function () {
            // Catches: explicit notify on kernel-only executeQueuedCells (e.g. reentrant ephemeral runs) when ranAgentCell is false.
            const {
                notebook: agentNotebook,
                cells: [agentCell, codeCell]
            } = createMockNotebookWithCells([
                {
                    metadata: { __deepnotePocket: { type: 'agent' }, id: 'agent-block-1' },
                    text: 'Test prompt'
                },
                {
                    metadata: { id: 'ephemeral-code-1' },
                    text: 'print(1)'
                }
            ]);

            const executeHandler = vscodeController.controller.executeHandler;
            assert.isDefined(executeHandler);

            notifyQueueCompleteSpy.resetHistory();

            await executeHandler([agentCell], agentNotebook, vscodeController.controller);

            try {
                await executeHandler([codeCell], agentNotebook, vscodeController.controller);
            } catch {
                // Kernel harness may not fully mock cell execution startup.
            }

            assert.strictEqual(
                notifyQueueCompleteSpy.callCount,
                1,
                'only the agent batch should fire explicit queue completion'
            );
        });

        test('kernel-only batch does not fire explicit queue completion notify', async function () {
            // Catches: explicit notify on pure kernel batches that already signal via CellExecutionQueue.
            const {
                notebook: codeNotebook,
                cells: [codeCell]
            } = createMockNotebookWithCells([
                {
                    metadata: { id: 'code-block-1' },
                    text: 'x = 1'
                }
            ]);

            const executeHandler = vscodeController.controller.executeHandler;
            assert.isDefined(executeHandler);

            try {
                await executeHandler([codeCell], codeNotebook, vscodeController.controller);
            } catch {
                // Kernel harness may not fully mock cell execution startup.
            }

            assert.isFalse(
                notifyQueueCompleteSpy.called,
                'batches without agent cells must rely on CellExecutionQueue for completion notify'
            );
        });
    });
});
