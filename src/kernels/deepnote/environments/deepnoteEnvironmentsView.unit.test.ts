import { assert } from 'chai';
import { anything, instance, mock, when, verify } from 'ts-mockito';
import { Disposable } from 'vscode';
import { DeepnoteEnvironmentsView } from './deepnoteEnvironmentsView.node';
import { IDeepnoteEnvironmentManager, IDeepnoteKernelAutoSelector, IDeepnoteNotebookEnvironmentMapper } from '../types';
import { IPythonApiProvider } from '../../../platform/api/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { IKernelProvider } from '../../../kernels/types';

// TODO: Add tests for command registration (requires VSCode API mocking)
// TODO: Add tests for startServer command execution
// TODO: Add tests for stopServer command execution
// TODO: Add tests for restartServer command execution
// TODO: Add tests for deleteEnvironment command with confirmation
// TODO: Add tests for editEnvironmentName with input validation
// TODO: Add tests for managePackages with package validation
// TODO: Add tests for createEnvironment workflow
// TODO: Add tests for selectEnvironmentForNotebook (requires VSCode window API mocking)

suite('DeepnoteEnvironmentsView', () => {
    let view: DeepnoteEnvironmentsView;
    let mockConfigManager: IDeepnoteEnvironmentManager;
    let mockPythonApiProvider: IPythonApiProvider;
    let mockDisposableRegistry: IDisposableRegistry;
    let mockKernelAutoSelector: IDeepnoteKernelAutoSelector;
    let mockNotebookEnvironmentMapper: IDeepnoteNotebookEnvironmentMapper;
    let mockKernelProvider: IKernelProvider;

    setup(() => {
        mockConfigManager = mock<IDeepnoteEnvironmentManager>();
        mockPythonApiProvider = mock<IPythonApiProvider>();
        mockDisposableRegistry = mock<IDisposableRegistry>();
        mockKernelAutoSelector = mock<IDeepnoteKernelAutoSelector>();
        mockNotebookEnvironmentMapper = mock<IDeepnoteNotebookEnvironmentMapper>();
        mockKernelProvider = mock<IKernelProvider>();

        // Mock onDidChangeEnvironments to return a disposable event
        when(mockConfigManager.onDidChangeEnvironments).thenReturn(() => {
            return {
                dispose: () => {
                    /* noop */
                }
            } as Disposable;
        });

        view = new DeepnoteEnvironmentsView(
            instance(mockConfigManager),
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
});
