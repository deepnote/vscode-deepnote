import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, when, verify, deepEqual, resetCalls } from 'ts-mockito';
import { CancellationToken, Disposable, NotebookDocument, ProgressOptions, Uri } from 'vscode';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView.node';
import { IDeepnoteEnvironmentManager, IDeepnoteKernelAutoSelector, IDeepnoteNotebookEnvironmentMapper } from '../types';
import { IPythonApiProvider } from '../../../platform/api/types';
import { ITelemetryService } from '../../../platform/analytics/types';
import { IDisposableRegistry, IOutputChannel } from '../../../platform/common/types';
import { IKernelProvider } from '../../../kernels/types';
import { DeepnoteEnvironment } from './deepnoteEnvironment';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteEnvironmentTreeDataProvider } from './deepnoteEnvironmentTreeDataProvider.node';
import { crateMockedPythonApi, whenKnownEnvironments } from '../../helpers.unit.test';
import type { PythonExtension } from '@vscode/python-extension';
import { createDeepnoteServerConfigHandle } from '../../../platform/deepnote/deepnoteServerUtils.node';

suite('DeepnoteEnvironmentsView', () => {
    let view: DeepnoteEnvironmentsView;
    let mockConfigManager: IDeepnoteEnvironmentManager;
    let mockTreeDataProvider: DeepnoteEnvironmentTreeDataProvider;
    let mockPythonApiProvider: IPythonApiProvider;
    let mockDisposableRegistry: IDisposableRegistry;
    let mockKernelAutoSelector: IDeepnoteKernelAutoSelector;
    let mockNotebookEnvironmentMapper: IDeepnoteNotebookEnvironmentMapper;
    let mockKernelProvider: IKernelProvider;
    let mockOutputChannel: IOutputChannel;
    let disposables: Disposable[] = [];
    let pythonEnvironments: PythonExtension['environments'];

    setup(() => {
        resetVSCodeMocks();
        disposables.push(new Disposable(() => resetVSCodeMocks()));

        // Initialize Python API for helper functions
        pythonEnvironments = crateMockedPythonApi(disposables).environments;

        mockConfigManager = mock<IDeepnoteEnvironmentManager>();
        mockTreeDataProvider = mock<DeepnoteEnvironmentTreeDataProvider>();
        mockPythonApiProvider = mock<IPythonApiProvider>();
        mockDisposableRegistry = mock<IDisposableRegistry>();
        mockKernelAutoSelector = mock<IDeepnoteKernelAutoSelector>();
        mockNotebookEnvironmentMapper = mock<IDeepnoteNotebookEnvironmentMapper>();
        mockKernelProvider = mock<IKernelProvider>();
        mockOutputChannel = mock<IOutputChannel>();

        // Mock onDidChangeEnvironments to return a disposable event
        when(mockConfigManager.onDidChangeEnvironments).thenReturn((_listener: () => void) => {
            return {
                dispose: () => {
                    /* noop */
                }
            };
        });

        view = new DeepnoteEnvironmentsView(
            instance(mockConfigManager),
            instance(mockTreeDataProvider),
            instance(mockPythonApiProvider),
            instance(mockDisposableRegistry),
            instance(mockKernelAutoSelector),
            instance(mockNotebookEnvironmentMapper),
            instance(mockKernelProvider),
            instance(mockOutputChannel),
            { trackEvent: sinon.stub(), dispose: sinon.stub().resolves() } as unknown as ITelemetryService
        );
    });

    teardown(() => {
        if (view) {
            view.dispose();
        }
        disposables.forEach((d) => d.dispose());
        disposables = [];
    });

    suite('constructor', () => {
        test('should create tree view', () => {
            // View should be created without errors
            assert.ok(view);
        });

        test('should register with disposable registry', () => {
            verify(mockDisposableRegistry.push(anything())).atLeast(1);
        });
    });

    suite('dispose', () => {
        test('should dispose all resources', () => {
            view.dispose();
            // Should not throw
        });

        test('should dispose tree view', () => {
            view.dispose();
            // Tree view should be disposed
            // In a real test, we would verify the tree view's dispose was called
        });
    });

    suite('editEnvironmentName', () => {
        const testEnvironmentId = 'test-env-id';
        const testInterpreter: PythonEnvironment = {
            id: 'test-python-id',
            uri: Uri.file('/usr/bin/python3'),
            version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
        } as PythonEnvironment;

        const testEnvironment: DeepnoteEnvironment = {
            id: testEnvironmentId,
            name: 'Original Name',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/venv'),
            managedVenv: true,
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const testEnvironmentExternal: DeepnoteEnvironment = {
            id: testEnvironmentId,
            name: 'Original Name',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/external/venv'),
            managedVenv: false,
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        setup(() => {
            // Reset mocks between tests
            resetCalls(mockConfigManager);
            resetCalls(mockedVSCodeNamespaces.window);
        });

        test('should return early if environment not found', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(undefined);

            await view.editEnvironmentName(testEnvironmentId);

            // Should not call showInputBox or updateEnvironment
            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).never();
            verify(mockConfigManager.updateEnvironment(anything(), anything())).never();
        });

        test('should return early if user cancels input', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(undefined));

            await view.editEnvironmentName(testEnvironmentId);

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
            verify(mockConfigManager.updateEnvironment(anything(), anything())).never();
        });

        test('should return early if user provides same name', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('Original Name'));

            await view.editEnvironmentName(testEnvironmentId);

            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).once();
            verify(mockConfigManager.updateEnvironment(anything(), anything())).never();
        });

        test('should validate that name cannot be empty', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);

            // Capture the validator function
            let validatorFn: ((value: string) => string | undefined) | undefined;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options) => {
                validatorFn = options.validateInput;
                return Promise.resolve(undefined);
            });

            await view.editEnvironmentName(testEnvironmentId);

            assert.ok(validatorFn, 'Validator function should be provided');
            assert.strictEqual(validatorFn!(''), 'Name cannot be empty');
            assert.strictEqual(validatorFn!('   '), 'Name cannot be empty');
            assert.strictEqual(validatorFn!('Valid Name'), undefined);
        });

        test('should successfully rename environment with trimmed name', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('  New Name  '));
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve();

            await view.editEnvironmentName(testEnvironmentId);

            verify(mockConfigManager.updateEnvironment(testEnvironmentId, deepEqual({ name: 'New Name' }))).once();
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should show error message if update fails', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('New Name'));
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenReject(new Error('Update failed'));
            when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenResolve();

            await view.editEnvironmentName(testEnvironmentId);

            verify(mockConfigManager.updateEnvironment(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.window.showErrorMessage(anything())).once();
        });

        test('should call updateEnvironment with correct parameters', async () => {
            const newName = 'Updated Environment Name';
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve(newName));
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve();

            await view.editEnvironmentName(testEnvironmentId);

            verify(mockConfigManager.updateEnvironment(testEnvironmentId, deepEqual({ name: newName }))).once();
        });

        test('should preserve existing environment configuration except name', async () => {
            const envWithPackages: DeepnoteEnvironment = {
                ...testEnvironment,
                packages: ['numpy', 'pandas'],
                description: 'Test description'
            };

            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(envWithPackages);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(Promise.resolve('New Name'));
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve();

            await view.editEnvironmentName(testEnvironmentId);

            // Should only update the name, not other properties
            verify(mockConfigManager.updateEnvironment(testEnvironmentId, deepEqual({ name: 'New Name' }))).once();
        });

        test('should show input box with current name as default value', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);

            let capturedOptions: any;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall((options) => {
                capturedOptions = options;
                return Promise.resolve(undefined);
            });

            await view.editEnvironmentName(testEnvironmentId);

            assert.ok(capturedOptions, 'Options should be provided');
            assert.strictEqual(capturedOptions.value, 'Original Name');
        });

        test('should successfully rename external environment (managedVenv: false)', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironmentExternal);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(
                Promise.resolve('New External Name')
            );
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenResolve();
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve();

            await view.editEnvironmentName(testEnvironmentId);

            verify(
                mockConfigManager.updateEnvironment(testEnvironmentId, deepEqual({ name: 'New External Name' }))
            ).once();
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });
    });

    suite('createEnvironmentCommand', () => {
        const testInterpreter: PythonEnvironment = {
            id: 'test-python-id',
            uri: Uri.file('/usr/bin/python3.11'),
            version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
        } as PythonEnvironment;

        const createdEnvironment: DeepnoteEnvironment = {
            id: 'new-env-id',
            name: 'My Data Science Environment',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/new/venv'),
            managedVenv: true,
            packages: ['pandas', 'numpy', 'matplotlib'],
            description: 'Environment for data science work',
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        setup(() => {
            resetCalls(mockConfigManager);
            resetCalls(mockPythonApiProvider);
            resetCalls(mockedVSCodeNamespaces.window);
        });

        test('should successfully create environment with all inputs', async () => {
            // Set up Python environments for helper functions to use
            const mockResolvedEnvironment = {
                id: testInterpreter.id,
                path: testInterpreter.uri.fsPath,
                version: {
                    major: 3,
                    minor: 11,
                    micro: 0
                },
                environment: {
                    name: 'test-env',
                    folderUri: testInterpreter.uri
                },
                tools: [],
                executable: {
                    uri: testInterpreter.uri
                }
            };

            // Configure the Python API that was initialized in setup()
            whenKnownEnvironments(pythonEnvironments).thenReturn([mockResolvedEnvironment]);

            // Mock the Python API provider to return the same environments
            const mockPythonApi = {
                environments: {
                    known: [mockResolvedEnvironment]
                }
            };
            when(mockPythonApiProvider.getNewApi()).thenResolve(mockPythonApi as any);

            // Mock interpreter selection - return the first item
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items: any[]) => {
                return Promise.resolve(items[0]);
            });

            // Mock input boxes for name, packages, and description
            let inputBoxCallCount = 0;
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenCall(() => {
                inputBoxCallCount++;
                if (inputBoxCallCount === 1) {
                    // First call: environment name
                    return Promise.resolve('My Data Science Environment');
                } else if (inputBoxCallCount === 2) {
                    // Second call: packages
                    return Promise.resolve('pandas, numpy, matplotlib');
                } else {
                    // Third call: description
                    return Promise.resolve('Environment for data science work');
                }
            });

            // Mock list environments to return empty (no duplicates)
            when(mockConfigManager.listEnvironments()).thenReturn([]);

            // Mock window.withProgress to execute the callback
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    const mockProgress = {
                        report: (_value: { message?: string; increment?: number }) => {
                            // Mock progress reporting
                        }
                    };
                    const mockToken = {
                        isCancellationRequested: false,
                        onCancellationRequested: (_listener: any) => {
                            return {
                                dispose: () => {
                                    // Mock disposable
                                }
                            };
                        }
                    };
                    return callback(mockProgress, mockToken);
                }
            );

            // Mock environment creation
            when(mockConfigManager.createEnvironment(anything(), anything())).thenResolve(createdEnvironment);

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.createEnvironmentCommand();

            // Verify API calls
            verify(mockPythonApiProvider.getNewApi()).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockedVSCodeNamespaces.window.showInputBox(anything())).times(3);
            verify(mockConfigManager.listEnvironments()).once();
            verify(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).once();

            // Verify createEnvironment was called with correct options
            verify(mockConfigManager.createEnvironment(anything(), anything())).once();
            const [capturedOptions, capturedToken] = capture(mockConfigManager.createEnvironment).last();
            assert.strictEqual(capturedOptions.name, 'My Data Science Environment');
            assert.deepStrictEqual(capturedOptions.packages, ['pandas', 'numpy', 'matplotlib']);
            assert.strictEqual(capturedOptions.description, 'Environment for data science work');
            // Don't assert on pythonInterpreter.id as the helper functions transform it
            assert.ok(capturedOptions.pythonInterpreter, 'Python interpreter should be provided');
            assert.ok(capturedOptions.pythonInterpreter.uri, 'Python interpreter uri should be present');
            assert.ok(capturedOptions.pythonInterpreter.id, 'Python interpreter id should be present');
            assert.ok(capturedToken, 'Cancellation token should be provided');

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });
    });

    suite('deleteEnvironmentCommand', () => {
        const testEnvironmentId = 'test-env-id-to-delete';
        const testExternalEnvironmentId = 'test-external-env-id-to-delete';
        const testInterpreter: PythonEnvironment = {
            id: 'test-python-id',
            uri: Uri.file('/usr/bin/python3.11'),
            version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
        } as PythonEnvironment;

        const testEnvironment: DeepnoteEnvironment = {
            id: testEnvironmentId,
            name: 'Environment to Delete',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/venv'),
            managedVenv: true,
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const testExternalEnvironment: DeepnoteEnvironment = {
            id: testExternalEnvironmentId,
            name: 'External Environment to Delete',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/external/venv'),
            managedVenv: false,
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        setup(() => {
            resetCalls(mockConfigManager);
            resetCalls(mockNotebookEnvironmentMapper);
            resetCalls(mockedVSCodeNamespaces.window);
        });

        test('should successfully delete environment with notebooks using it', async () => {
            // Mock environment exists
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);

            // Mock user confirmation - user clicks "Delete" button
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            // Mock notebooks using this environment
            const notebook1Uri = Uri.file('/workspace/notebook1.deepnote');
            const notebook2Uri = Uri.file('/workspace/notebook2.deepnote');
            when(mockNotebookEnvironmentMapper.getNotebooksUsingEnvironment(testEnvironmentId)).thenReturn([
                notebook1Uri,
                notebook2Uri
            ]);

            // Mock removing environment mappings
            when(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(anything())).thenResolve();

            // Mock window.withProgress to execute the callback
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    const mockProgress = {
                        report: (_value: { message?: string; increment?: number }) => {
                            // Mock progress reporting
                        }
                    };
                    const mockToken: CancellationToken = {
                        isCancellationRequested: false,
                        onCancellationRequested: (_listener: any) => {
                            return {
                                dispose: () => {
                                    // Mock disposable
                                }
                            };
                        }
                    };
                    return callback(mockProgress, mockToken);
                }
            );

            // Mock environment deletion
            when(mockConfigManager.deleteEnvironment(testEnvironmentId, anything())).thenResolve();

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.deleteEnvironmentCommand(testEnvironmentId);

            // Verify API calls
            verify(mockConfigManager.getEnvironment(testEnvironmentId)).once();
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).once();
            verify(mockNotebookEnvironmentMapper.getNotebooksUsingEnvironment(testEnvironmentId)).once();

            // Verify environment mappings were removed for both notebooks
            verify(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(notebook1Uri)).once();
            verify(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(notebook2Uri)).once();

            // Verify environment deletion
            verify(mockConfigManager.deleteEnvironment(testEnvironmentId, anything())).once();

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should dispose kernels from open notebooks using the deleted environment', async () => {
            // Mock environment exists
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);

            // Mock user confirmation
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            // Mock notebooks using this environment
            when(mockNotebookEnvironmentMapper.getNotebooksUsingEnvironment(testEnvironmentId)).thenReturn([]);
            when(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(anything())).thenResolve();

            // Mock open notebooks with kernels
            const openNotebook1 = {
                uri: Uri.file('/workspace/open-notebook1.deepnote'),
                notebookType: 'deepnote',
                isClosed: false
            } as any;

            const openNotebook2 = {
                uri: Uri.file('/workspace/open-notebook2.deepnote'),
                notebookType: 'jupyter-notebook',
                isClosed: false
            } as any;

            const openNotebook3 = {
                uri: Uri.file('/workspace/open-notebook3.deepnote'),
                notebookType: 'deepnote',
                isClosed: false
            } as any;

            // Mock workspace.notebookDocuments
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([
                openNotebook1,
                openNotebook2,
                openNotebook3
            ]);

            // Mock kernels
            const mockKernel1 = {
                kernelConnectionMetadata: {
                    kind: 'startUsingDeepnoteKernel',
                    serverProviderHandle: {
                        handle: createDeepnoteServerConfigHandle(testEnvironmentId, openNotebook1.uri)
                    }
                },
                dispose: sinon.stub().resolves()
            };

            const mockKernel3 = {
                kernelConnectionMetadata: {
                    kind: 'startUsingDeepnoteKernel',
                    serverProviderHandle: {
                        handle: createDeepnoteServerConfigHandle('different-env-id', openNotebook3.uri)
                    }
                },
                dispose: sinon.stub().resolves()
            };

            // Mock kernelProvider.get()
            when(mockKernelProvider.get(openNotebook1)).thenReturn(mockKernel1 as any);
            when(mockKernelProvider.get(openNotebook2)).thenReturn(undefined); // No kernel for jupyter notebook
            when(mockKernelProvider.get(openNotebook3)).thenReturn(mockKernel3 as any);

            // Mock window.withProgress
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    const mockProgress = {
                        report: () => {
                            // Mock progress reporting
                        }
                    };
                    const mockToken: CancellationToken = {
                        isCancellationRequested: false,
                        onCancellationRequested: () => ({
                            dispose: () => {
                                // Mock disposable
                            }
                        })
                    };
                    return callback(mockProgress, mockToken);
                }
            );

            // Mock environment deletion
            when(mockConfigManager.deleteEnvironment(testEnvironmentId, anything())).thenResolve();
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.deleteEnvironmentCommand(testEnvironmentId);

            // Verify that only kernel1 (using the deleted environment) was disposed
            assert.strictEqual(mockKernel1.dispose.callCount, 1, 'Kernel using deleted environment should be disposed');
            assert.strictEqual(
                mockKernel3.dispose.callCount,
                0,
                'Kernel using different environment should not be disposed'
            );
        });

        test('should successfully delete external environment (managedVenv: false) with same side effects', async () => {
            // Mock environment exists - external environment
            when(mockConfigManager.getEnvironment(testExternalEnvironmentId)).thenReturn(testExternalEnvironment);

            // Mock user confirmation - user clicks "Delete" button
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            // Mock notebooks using this environment
            const notebook1Uri = Uri.file('/workspace/notebook1.deepnote');
            const notebook2Uri = Uri.file('/workspace/notebook2.deepnote');
            when(mockNotebookEnvironmentMapper.getNotebooksUsingEnvironment(testExternalEnvironmentId)).thenReturn([
                notebook1Uri,
                notebook2Uri
            ]);

            // Mock removing environment mappings
            when(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(anything())).thenResolve();

            // Mock open notebooks
            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

            // Mock window.withProgress to execute the callback
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    const mockProgress = {
                        report: (_value: { message?: string; increment?: number }) => {
                            // Mock progress reporting
                        }
                    };
                    const mockToken: CancellationToken = {
                        isCancellationRequested: false,
                        onCancellationRequested: (_listener: any) => {
                            return {
                                dispose: () => {
                                    // Mock disposable
                                }
                            };
                        }
                    };
                    return callback(mockProgress, mockToken);
                }
            );

            // Mock environment deletion - the manager handles managedVenv check internally
            when(mockConfigManager.deleteEnvironment(testExternalEnvironmentId, anything())).thenResolve();

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.deleteEnvironmentCommand(testExternalEnvironmentId);

            // Verify API calls - same as for managed venv
            verify(mockConfigManager.getEnvironment(testExternalEnvironmentId)).once();
            verify(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).once();
            verify(mockNotebookEnvironmentMapper.getNotebooksUsingEnvironment(testExternalEnvironmentId)).once();

            // Verify environment mappings were removed for both notebooks
            verify(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(notebook1Uri)).once();
            verify(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(notebook2Uri)).once();

            // Verify environment deletion - the manager is responsible for checking managedVenv
            verify(mockConfigManager.deleteEnvironment(testExternalEnvironmentId, anything())).once();

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should dispose kernels from open notebooks using deleted external environment (managedVenv: false)', async () => {
            // Mock environment exists - external environment
            when(mockConfigManager.getEnvironment(testExternalEnvironmentId)).thenReturn(testExternalEnvironment);

            // Mock user confirmation
            when(mockedVSCodeNamespaces.window.showWarningMessage(anything(), anything(), anything())).thenReturn(
                Promise.resolve('Delete')
            );

            // Mock notebooks using this environment
            when(mockNotebookEnvironmentMapper.getNotebooksUsingEnvironment(testExternalEnvironmentId)).thenReturn([]);
            when(mockNotebookEnvironmentMapper.removeEnvironmentForNotebook(anything())).thenResolve();

            // Mock open notebooks with kernels
            const openNotebook1 = {
                uri: Uri.file('/workspace/open-notebook1.deepnote'),
                notebookType: 'deepnote',
                isClosed: false
            } as any;

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([openNotebook1]);

            // Mock kernel using the external environment
            const mockKernel1 = {
                kernelConnectionMetadata: {
                    kind: 'startUsingDeepnoteKernel',
                    serverProviderHandle: {
                        handle: createDeepnoteServerConfigHandle(testExternalEnvironmentId, openNotebook1.uri)
                    }
                },
                dispose: sinon.stub().resolves()
            };

            when(mockKernelProvider.get(openNotebook1)).thenReturn(mockKernel1 as any);

            // Mock window.withProgress
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    const mockProgress = {
                        report: () => {
                            // Mock progress reporting
                        }
                    };
                    const mockToken: CancellationToken = {
                        isCancellationRequested: false,
                        onCancellationRequested: () => ({
                            dispose: () => {
                                // Mock disposable
                            }
                        })
                    };
                    return callback(mockProgress, mockToken);
                }
            );

            // Mock environment deletion
            when(mockConfigManager.deleteEnvironment(testExternalEnvironmentId, anything())).thenResolve();
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.deleteEnvironmentCommand(testExternalEnvironmentId);

            // Verify that kernel was disposed even for external environment
            assert.strictEqual(
                mockKernel1.dispose.callCount,
                1,
                'Kernel using deleted external environment should be disposed'
            );
        });
    });

    suite('selectEnvironmentForNotebook', () => {
        const testInterpreter1: PythonEnvironment = {
            id: 'python-1',
            uri: Uri.file('/usr/bin/python3.11'),
            version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
        } as PythonEnvironment;

        const testInterpreter2: PythonEnvironment = {
            id: 'python-2',
            uri: Uri.file('/usr/bin/python3.12'),
            version: { major: 3, minor: 12, patch: 0, raw: '3.12.0' }
        } as PythonEnvironment;

        const currentEnvironment: DeepnoteEnvironment = {
            id: 'current-env-id',
            name: 'Current Environment',
            pythonInterpreter: testInterpreter1,
            venvPath: Uri.file('/path/to/current/venv'),
            managedVenv: true,
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const currentExternalEnvironment: DeepnoteEnvironment = {
            id: 'current-external-env-id',
            name: 'Current External Environment',
            pythonInterpreter: testInterpreter1,
            venvPath: Uri.file('/path/to/external/current/venv'),
            managedVenv: false,
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const newEnvironment: DeepnoteEnvironment = {
            id: 'new-env-id',
            name: 'New Environment',
            pythonInterpreter: testInterpreter2,
            venvPath: Uri.file('/path/to/new/venv'),
            managedVenv: true,
            packages: ['pandas', 'numpy'],
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const newExternalEnvironment: DeepnoteEnvironment = {
            id: 'new-external-env-id',
            name: 'New External Environment',
            pythonInterpreter: testInterpreter2,
            venvPath: Uri.file('/path/to/external/new/venv'),
            managedVenv: false,
            packages: ['requests'],
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        setup(() => {
            resetCalls(mockConfigManager);
            resetCalls(mockNotebookEnvironmentMapper);
            resetCalls(mockKernelAutoSelector);
            resetCalls(mockKernelProvider);
            resetCalls(mockedVSCodeNamespaces.window);
        });

        test('should successfully switch to a different environment', async () => {
            // Mock active notebook
            const notebookUri = Uri.file('/workspace/notebook.deepnote');
            const mockNotebook = {
                uri: notebookUri,
                notebookType: 'deepnote',
                cellCount: 5
            };
            const mockNotebookEditor = {
                notebook: mockNotebook
            };

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(mockNotebookEditor as any);

            // Mock current environment mapping
            const baseFileUri = notebookUri.with({ query: '', fragment: '' });
            when(mockNotebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri)).thenReturn(
                currentEnvironment.id
            );
            when(mockConfigManager.getEnvironment(currentEnvironment.id)).thenReturn(currentEnvironment);

            // Mock available environments
            when(mockConfigManager.listEnvironments()).thenReturn([currentEnvironment, newEnvironment]);

            // Mock environment status
            when(mockConfigManager.getEnvironment(currentEnvironment.id)).thenReturn(currentEnvironment);
            when(mockConfigManager.getEnvironment(newEnvironment.id)).thenReturn(newEnvironment);

            // Mock user selecting the new environment
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items: any[]) => {
                // Find the item for the new environment
                const selectedItem = items.find((item) => item.environmentId === newEnvironment.id);
                return Promise.resolve(selectedItem);
            });

            // Mock no executing cells
            const mockKernel = { id: 'test-kernel' };
            const mockKernelExecution = {
                pendingCells: []
            };
            when(mockKernelProvider.get(mockNotebook as any)).thenReturn(mockKernel as any);
            when(mockKernelProvider.getKernelExecution(mockKernel as any)).thenReturn(mockKernelExecution as any);

            // Mock window.withProgress to execute the callback
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    return callback();
                }
            );

            // Mock environment mapping update
            when(mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newEnvironment.id)).thenResolve();

            // Mock controller rebuild
            when(mockKernelAutoSelector.rebuildController(mockNotebook as any, anything(), anything())).thenResolve();

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.selectEnvironmentForNotebook({ notebook: mockNotebook as NotebookDocument });

            // Verify API calls
            verify(mockNotebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri)).once();
            verify(mockConfigManager.getEnvironment(currentEnvironment.id)).once();
            verify(mockConfigManager.listEnvironments()).once();
            verify(mockConfigManager.getEnvironment(currentEnvironment.id)).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockKernelProvider.get(mockNotebook as any)).once();
            verify(mockKernelProvider.getKernelExecution(mockKernel as any)).once();

            // Verify environment switch
            verify(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).once();
            verify(mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newEnvironment.id)).once();
            verify(mockKernelAutoSelector.rebuildController(mockNotebook as any, anything(), anything())).once();

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should successfully switch from managed to external environment (managedVenv: false)', async () => {
            // Mock active notebook
            const notebookUri = Uri.file('/workspace/notebook.deepnote');
            const mockNotebook = {
                uri: notebookUri,
                notebookType: 'deepnote',
                cellCount: 5
            };
            const mockNotebookEditor = {
                notebook: mockNotebook
            };

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(mockNotebookEditor as any);

            // Mock current environment mapping (managed)
            const baseFileUri = notebookUri.with({ query: '', fragment: '' });
            when(mockNotebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri)).thenReturn(
                currentEnvironment.id
            );
            when(mockConfigManager.getEnvironment(currentEnvironment.id)).thenReturn(currentEnvironment);

            // Mock available environments (mix of managed and external)
            when(mockConfigManager.listEnvironments()).thenReturn([
                currentEnvironment,
                newEnvironment,
                newExternalEnvironment
            ]);

            // Mock environment status
            when(mockConfigManager.getEnvironment(newExternalEnvironment.id)).thenReturn(newExternalEnvironment);

            // Mock user selecting the new external environment
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items: any[]) => {
                // Find the item for the new external environment
                const selectedItem = items.find((item) => item.environmentId === newExternalEnvironment.id);
                return Promise.resolve(selectedItem);
            });

            // Mock no executing cells
            const mockKernel = { id: 'test-kernel' };
            const mockKernelExecution = {
                pendingCells: []
            };
            when(mockKernelProvider.get(mockNotebook as any)).thenReturn(mockKernel as any);
            when(mockKernelProvider.getKernelExecution(mockKernel as any)).thenReturn(mockKernelExecution as any);

            // Mock window.withProgress to execute the callback
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    return callback();
                }
            );

            // Mock environment mapping update
            when(
                mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newExternalEnvironment.id)
            ).thenResolve();

            // Mock controller rebuild
            when(mockKernelAutoSelector.rebuildController(mockNotebook as any, anything(), anything())).thenResolve();

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.selectEnvironmentForNotebook({ notebook: mockNotebook as NotebookDocument });

            // Verify environment switch to external environment
            verify(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).once();
            verify(
                mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newExternalEnvironment.id)
            ).once();
            verify(mockKernelAutoSelector.rebuildController(mockNotebook as any, anything(), anything())).once();

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });

        test('should successfully switch from external to managed environment', async () => {
            // Mock active notebook
            const notebookUri = Uri.file('/workspace/notebook.deepnote');
            const mockNotebook = {
                uri: notebookUri,
                notebookType: 'deepnote',
                cellCount: 5
            };
            const mockNotebookEditor = {
                notebook: mockNotebook
            };

            when(mockedVSCodeNamespaces.window.activeNotebookEditor).thenReturn(mockNotebookEditor as any);

            // Mock current environment mapping (external)
            const baseFileUri = notebookUri.with({ query: '', fragment: '' });
            when(mockNotebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri)).thenReturn(
                currentExternalEnvironment.id
            );
            when(mockConfigManager.getEnvironment(currentExternalEnvironment.id)).thenReturn(
                currentExternalEnvironment
            );

            // Mock available environments
            when(mockConfigManager.listEnvironments()).thenReturn([currentExternalEnvironment, newEnvironment]);

            // Mock environment status
            when(mockConfigManager.getEnvironment(newEnvironment.id)).thenReturn(newEnvironment);

            // Mock user selecting the new managed environment
            when(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).thenCall((items: any[]) => {
                const selectedItem = items.find((item) => item.environmentId === newEnvironment.id);
                return Promise.resolve(selectedItem);
            });

            // Mock no executing cells
            const mockKernel = { id: 'test-kernel' };
            const mockKernelExecution = {
                pendingCells: []
            };
            when(mockKernelProvider.get(mockNotebook as any)).thenReturn(mockKernel as any);
            when(mockKernelProvider.getKernelExecution(mockKernel as any)).thenReturn(mockKernelExecution as any);

            // Mock window.withProgress to execute the callback
            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    return callback();
                }
            );

            // Mock environment mapping update
            when(mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newEnvironment.id)).thenResolve();

            // Mock controller rebuild
            when(mockKernelAutoSelector.rebuildController(mockNotebook as any, anything(), anything())).thenResolve();

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.selectEnvironmentForNotebook({ notebook: mockNotebook as NotebookDocument });

            // Verify environment switch from external to managed
            verify(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).once();
            verify(mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newEnvironment.id)).once();
            verify(mockKernelAutoSelector.rebuildController(mockNotebook as any, anything(), anything())).once();

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });
    });

    suite('managePackages', () => {
        const testEnvironmentId = 'test-env-id';
        const testExternalEnvironmentId = 'test-external-env-id';
        const testInterpreter: PythonEnvironment = {
            id: 'test-python-id',
            uri: Uri.file('/usr/bin/python3'),
            version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
        } as PythonEnvironment;

        const testEnvironment: DeepnoteEnvironment = {
            id: testEnvironmentId,
            name: 'Test Environment',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/venv'),
            managedVenv: true,
            packages: ['numpy', 'pandas'],
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const testExternalEnvironment: DeepnoteEnvironment = {
            id: testExternalEnvironmentId,
            name: 'Test External Environment',
            pythonInterpreter: testInterpreter,
            venvPath: Uri.file('/path/to/external/venv'),
            managedVenv: false,
            packages: ['requests'],
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        setup(() => {
            resetCalls(mockConfigManager);
            resetCalls(mockedVSCodeNamespaces.window);
        });

        test('should call environmentManager.updateEnvironment with parsed packages', async () => {
            when(mockConfigManager.getEnvironment(testEnvironmentId)).thenReturn(testEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(
                Promise.resolve('matplotlib, scipy, sklearn')
            );
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenResolve();

            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    return callback();
                }
            );

            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            await (view as any).managePackages(testEnvironmentId);

            verify(
                mockConfigManager.updateEnvironment(
                    testEnvironmentId,
                    deepEqual({ packages: ['matplotlib', 'scipy', 'sklearn'] })
                )
            ).once();
        });

        test('should update packages for external environment (managedVenv: false)', async () => {
            when(mockConfigManager.getEnvironment(testExternalEnvironmentId)).thenReturn(testExternalEnvironment);
            when(mockedVSCodeNamespaces.window.showInputBox(anything())).thenReturn(
                Promise.resolve('flask, sqlalchemy')
            );
            when(mockConfigManager.updateEnvironment(anything(), anything())).thenResolve();

            when(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).thenCall(
                (_options: ProgressOptions, callback: Function) => {
                    return callback();
                }
            );

            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            await (view as any).managePackages(testExternalEnvironmentId);

            verify(
                mockConfigManager.updateEnvironment(
                    testExternalEnvironmentId,
                    deepEqual({ packages: ['flask', 'sqlalchemy'] })
                )
            ).once();
        });
    });
});
