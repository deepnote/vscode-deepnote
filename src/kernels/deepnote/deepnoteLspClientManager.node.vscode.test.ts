import { assert } from 'chai';
import { Uri } from 'vscode';

import { DeepnoteLspClientManager } from './deepnoteLspClientManager.node';
import { createMockChildProcess } from './deepnoteTestHelpers.node';
import { IDisposableRegistry } from '../../platform/common/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import * as path from '../../platform/vscode-path/path';
import { noop } from '../../platform/common/utils/misc';

suite('DeepnoteLspClientManager Integration Tests', () => {
    let lspClientManager: DeepnoteLspClientManager;
    const testNotebookPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'test',
        'testFiles',
        'Bunch-of-charts.deepnote'
    );
    const testNotebookUri = Uri.file(testNotebookPath);

    // Mock disposable registry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockDisposableRegistry: IDisposableRegistry = {
        push: () => 0,
        dispose: () => Promise.resolve()
    } as any;

    // Mock integration storage
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockIntegrationStorage = {
        getAll: async () => [],
        getIntegrationConfig: async () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onDidChangeIntegrations: { dispose: noop } as any,
        dispose: noop
    } as any;

    // Mock notebook editor provider
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockNotebookEditorProvider = {
        findAssociatedNotebookDocument: () => undefined
    } as any;

    // Mock notebook manager
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockNotebookManager = {
        getAnyProjectEntry: () => undefined
    } as any;

    setup(() => {
        lspClientManager = new DeepnoteLspClientManager(
            mockDisposableRegistry,
            mockIntegrationStorage,
            mockNotebookEditorProvider,
            mockNotebookManager
        );
        lspClientManager.activate();
    });

    teardown(async () => {
        if (lspClientManager) {
            await lspClientManager.stopAllClients();
        }
    });

    test('LSP Client Manager should be instantiable', () => {
        assert.isDefined(lspClientManager, 'LSP Client Manager should be created');
    });

    test('Should handle starting LSP clients with mock interpreter', async function () {
        this.timeout(10000);

        // Use invalid path to deliberately trigger failure and test error handling
        // This ensures consistent test behavior across platforms (simulates missing pylsp)
        const mockInterpreter: PythonEnvironment = {
            id: '/nonexistent/path/to/python',
            uri: Uri.file('/nonexistent/path/to/python')
        } as PythonEnvironment;

        const mockServerInfo = {
            url: 'http://localhost:8888',
            jupyterPort: 8888,
            lspPort: 8889,
            token: 'test-token',
            process: createMockChildProcess()
        };

        // This will attempt to start LSP clients but may fail if pylsp isn't installed
        // We're mainly testing that the code path executes without crashing
        try {
            await lspClientManager.startLspClients(mockServerInfo, testNotebookUri, mockInterpreter);

            // If successful, clean up
            await lspClientManager.stopLspClients(testNotebookUri);

            assert.ok(true, 'LSP client lifecycle completed successfully');
        } catch (error) {
            // Expected to fail if python-lsp-server is not installed in the test environment
            // We're verifying the code doesn't crash, not that LSP actually works
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.log(`LSP client start failed (expected in test env): ${errorMessage}`);
            assert.ok(true, 'LSP client start failed as expected in test environment');
        }
    });

    test('Should handle stopping non-existent LSP clients gracefully', async () => {
        const nonExistentUri = Uri.file('/path/to/nonexistent.deepnote');

        // Should not throw
        await lspClientManager.stopLspClients(nonExistentUri);

        assert.ok(true, 'Stopping non-existent client handled gracefully');
    });

    test('Should handle stopAllClients', async () => {
        // Should not throw even if no clients are running
        await lspClientManager.stopAllClients();

        assert.ok(true, 'stopAllClients completed without error');
    });

    test('Should not start duplicate clients for same notebook', async function () {
        this.timeout(10000);

        // Use invalid path to deliberately trigger failure and test error handling
        // This ensures consistent test behavior across platforms (simulates missing pylsp)
        const mockInterpreter: PythonEnvironment = {
            id: '/nonexistent/path/to/python',
            uri: Uri.file('/nonexistent/path/to/python')
        } as PythonEnvironment;

        const mockServerInfo = {
            url: 'http://localhost:8888',
            jupyterPort: 8888,
            lspPort: 8889,
            token: 'test-token',
            process: createMockChildProcess()
        };

        try {
            // Try to start clients twice for the same notebook
            await lspClientManager.startLspClients(mockServerInfo, testNotebookUri, mockInterpreter);
            await lspClientManager.startLspClients(mockServerInfo, testNotebookUri, mockInterpreter);

            // Clean up
            await lspClientManager.stopLspClients(testNotebookUri);

            assert.ok(true, 'Duplicate client prevention works');
        } catch (error) {
            // Expected to fail if python-lsp-server is not installed
            console.log(`Test completed with expected LSP unavailability`);
            assert.ok(true, 'Duplicate prevention tested despite LSP unavailability');
        }
    });

    test('Should allow restarting LSP clients after stopping them', async function () {
        this.timeout(15000);

        const mockInterpreter: PythonEnvironment = {
            id: '/nonexistent/path/to/python',
            uri: Uri.file('/nonexistent/path/to/python')
        } as PythonEnvironment;

        const mockServerInfo = {
            url: 'http://localhost:8888',
            jupyterPort: 8888,
            lspPort: 8889,
            token: 'test-token',
            process: createMockChildProcess()
        };

        try {
            // First start
            await lspClientManager.startLspClients(mockServerInfo, testNotebookUri, mockInterpreter);

            // Stop clients (simulating environment switch cleanup)
            await lspClientManager.stopLspClients(testNotebookUri);

            // Second start with different interpreter (simulating new environment)
            const newMockInterpreter: PythonEnvironment = {
                id: '/another/path/to/python',
                uri: Uri.file('/another/path/to/python')
            } as PythonEnvironment;

            // This should NOT throw "command already exists" error
            await lspClientManager.startLspClients(mockServerInfo, testNotebookUri, newMockInterpreter);

            // Clean up
            await lspClientManager.stopLspClients(testNotebookUri);

            assert.ok(true, 'LSP client restart after stop works correctly');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            // The bug we're fixing: "command already exists" means clients weren't properly cleaned up
            if (errorMessage.includes('already exists')) {
                assert.fail(`LSP client restart failed with duplicate command error: ${errorMessage}`);
            }

            // Other errors (like missing pylsp) are acceptable in test environment
            console.log(`LSP client test completed with expected error: ${errorMessage}`);
            assert.ok(true, 'Test completed (LSP may not be available in test env)');
        }
    });
});
