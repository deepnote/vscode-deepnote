import { assert } from 'chai';
import { anything, instance, mock, when, verify, deepEqual, resetCalls } from 'ts-mockito';
import { Disposable, Uri } from 'vscode';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView.node';
import { IDeepnoteEnvironmentManager, IDeepnoteKernelAutoSelector, IDeepnoteNotebookEnvironmentMapper } from '../types';
import { IPythonApiProvider } from '../../../platform/api/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { IKernelProvider } from '../../../kernels/types';
import { DeepnoteEnvironment } from './deepnoteEnvironment';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { DeepnoteEnvironmentTreeDataProvider } from './deepnoteEnvironmentTreeDataProvider.node';

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
});
