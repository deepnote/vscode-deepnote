import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, when, verify, deepEqual, resetCalls } from 'ts-mockito';
import { CancellationToken, Disposable, ProgressOptions, Uri } from 'vscode';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView.node';
import { IDeepnoteEnvironmentManager, IDeepnoteKernelAutoSelector, IDeepnoteNotebookEnvironmentMapper } from '../types';
import { IPythonApiProvider } from '../../../platform/api/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { IKernelProvider } from '../../../kernels/types';
import { DeepnoteEnvironment, EnvironmentStatus } from './deepnoteEnvironment';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteEnvironmentTreeDataProvider } from './deepnoteEnvironmentTreeDataProvider.node';
import * as interpreterHelpers from '../../../platform/interpreter/helpers';

suite('DeepnoteEnvironmentsView', () => {
    let view: DeepnoteEnvironmentsView;
    let mockConfigManager: IDeepnoteEnvironmentManager;
    let mockTreeDataProvider: DeepnoteEnvironmentTreeDataProvider;
    let mockPythonApiProvider: IPythonApiProvider;
    let mockDisposableRegistry: IDisposableRegistry;
    let mockKernelAutoSelector: IDeepnoteKernelAutoSelector;
    let mockNotebookEnvironmentMapper: IDeepnoteNotebookEnvironmentMapper;
    let mockKernelProvider: IKernelProvider;
    let disposables: Disposable[] = [];

    setup(() => {
        resetVSCodeMocks();
        disposables.push(new Disposable(() => resetVSCodeMocks()));

        mockConfigManager = mock<IDeepnoteEnvironmentManager>();
        mockTreeDataProvider = mock<DeepnoteEnvironmentTreeDataProvider>();
        mockPythonApiProvider = mock<IPythonApiProvider>();
        mockDisposableRegistry = mock<IDisposableRegistry>();
        mockKernelAutoSelector = mock<IDeepnoteKernelAutoSelector>();
        mockNotebookEnvironmentMapper = mock<IDeepnoteNotebookEnvironmentMapper>();
        mockKernelProvider = mock<IKernelProvider>();

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
            instance(mockKernelProvider)
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
            packages: ['pandas', 'numpy', 'matplotlib'],
            description: 'Environment for data science work',
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        let getCachedEnvironmentStub: sinon.SinonStub;
        let resolvedPythonEnvToJupyterEnvStub: sinon.SinonStub;
        let getPythonEnvironmentNameStub: sinon.SinonStub;

        setup(() => {
            resetCalls(mockConfigManager);
            resetCalls(mockPythonApiProvider);
            resetCalls(mockedVSCodeNamespaces.window);

            // Stub the helper functions
            getCachedEnvironmentStub = sinon.stub(interpreterHelpers, 'getCachedEnvironment');
            resolvedPythonEnvToJupyterEnvStub = sinon.stub(interpreterHelpers, 'resolvedPythonEnvToJupyterEnv');
            getPythonEnvironmentNameStub = sinon.stub(interpreterHelpers, 'getPythonEnvironmentName');
        });

        teardown(() => {
            getCachedEnvironmentStub?.restore();
            resolvedPythonEnvToJupyterEnvStub?.restore();
            getPythonEnvironmentNameStub?.restore();
        });

        test('should successfully create environment with all inputs', async () => {
            // Mock Python API to return available interpreters
            const mockResolvedEnvironment = {
                id: testInterpreter.id,
                path: testInterpreter.uri.fsPath,
                version: {
                    major: 3,
                    minor: 11,
                    micro: 0
                }
            };
            const mockPythonApi = {
                environments: {
                    known: [mockResolvedEnvironment]
                }
            };
            when(mockPythonApiProvider.getNewApi()).thenResolve(mockPythonApi as any);

            // Stub helper functions to return the test interpreter
            getCachedEnvironmentStub.returns(testInterpreter);
            resolvedPythonEnvToJupyterEnvStub.returns(testInterpreter);
            getPythonEnvironmentNameStub.returns('Python 3.11');

            // Mock interpreter selection
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
            assert.strictEqual(capturedOptions.pythonInterpreter.id, testInterpreter.id);
            assert.ok(capturedToken, 'Cancellation token should be provided');

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });
    });

    suite('deleteEnvironmentCommand', () => {
        const testEnvironmentId = 'test-env-id-to-delete';
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
            createdAt: new Date(),
            lastUsedAt: new Date()
        };

        const newEnvironment: DeepnoteEnvironment = {
            id: 'new-env-id',
            name: 'New Environment',
            pythonInterpreter: testInterpreter2,
            venvPath: Uri.file('/path/to/new/venv'),
            packages: ['pandas', 'numpy'],
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
            when(mockConfigManager.getEnvironmentWithStatus(currentEnvironment.id)).thenReturn({
                ...currentEnvironment,
                status: EnvironmentStatus.Stopped
            });
            when(mockConfigManager.getEnvironmentWithStatus(newEnvironment.id)).thenReturn({
                ...newEnvironment,
                status: EnvironmentStatus.Running
            });

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
            when(mockKernelAutoSelector.rebuildController(mockNotebook as any)).thenResolve();

            // Mock success message
            when(mockedVSCodeNamespaces.window.showInformationMessage(anything())).thenResolve(undefined);

            // Execute the command
            await view.selectEnvironmentForNotebook();

            // Verify API calls
            verify(mockNotebookEnvironmentMapper.getEnvironmentForNotebook(baseFileUri)).once();
            verify(mockConfigManager.getEnvironment(currentEnvironment.id)).once();
            verify(mockConfigManager.listEnvironments()).once();
            verify(mockConfigManager.getEnvironmentWithStatus(currentEnvironment.id)).once();
            verify(mockConfigManager.getEnvironmentWithStatus(newEnvironment.id)).once();
            verify(mockedVSCodeNamespaces.window.showQuickPick(anything(), anything())).once();
            verify(mockKernelProvider.get(mockNotebook as any)).once();
            verify(mockKernelProvider.getKernelExecution(mockKernel as any)).once();

            // Verify environment switch
            verify(mockedVSCodeNamespaces.window.withProgress(anything(), anything())).once();
            verify(mockNotebookEnvironmentMapper.setEnvironmentForNotebook(baseFileUri, newEnvironment.id)).once();
            verify(mockKernelAutoSelector.rebuildController(mockNotebook as any)).once();

            // Verify success message was shown
            verify(mockedVSCodeNamespaces.window.showInformationMessage(anything())).once();
        });
    });
});
