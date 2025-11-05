import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IHttpClient, IOutputChannel } from '../../platform/common/types';
import { IDeepnoteToolkitInstaller } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';

/**
 * Integration tests for DeepnoteServerStarter port allocation logic.
 * These tests use real port checking to ensure consecutive ports are allocated.
 *
 * Note: These are integration tests that actually check port availability on the system.
 * They test the critical fix where consecutive ports must be available.
 */
suite('DeepnoteServerStarter - Port Allocation Integration Tests', () => {
    let serverStarter: DeepnoteServerStarter;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockToolkitInstaller: IDeepnoteToolkitInstaller;
    let mockOutputChannel: IOutputChannel;
    let mockHttpClient: IHttpClient;
    let mockAsyncRegistry: IAsyncDisposableRegistry;
    let mockSqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;

    // Helper to access private methods for testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getPrivateMethod = (obj: any, methodName: string) => {
        return obj[methodName].bind(obj);
    };

    setup(() => {
        // Create mocks
        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockToolkitInstaller = mock<IDeepnoteToolkitInstaller>();
        mockOutputChannel = mock<IOutputChannel>();
        mockHttpClient = mock<IHttpClient>();
        mockAsyncRegistry = mock<IAsyncDisposableRegistry>();
        mockSqlIntegrationEnvVars = mock<ISqlIntegrationEnvVarsProvider>();

        when(mockAsyncRegistry.push(anything())).thenReturn();
        when(mockOutputChannel.appendLine(anything())).thenReturn();

        serverStarter = new DeepnoteServerStarter(
            instance(mockProcessServiceFactory),
            instance(mockToolkitInstaller),
            instance(mockOutputChannel),
            instance(mockHttpClient),
            instance(mockAsyncRegistry),
            instance(mockSqlIntegrationEnvVars)
        );
    });

    suite('isPortAvailable', () => {
        test('should return true when port is available', async () => {
            // Use a high unlikely-to-be-used port
            const port = 54321;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const isPortAvailable = getPrivateMethod(serverStarter as any, 'isPortAvailable');
            const result = await isPortAvailable(port);

            // Port should be available (or test might be flaky if something uses this port)
            assert.isTrue(result, 'Port 54321 should be available');
        });

        test('CRITICAL: should return false when port is actually in use', async () => {
            // This is the test that would have caught the bug!
            // We actually bind to a port and verify isPortAvailable detects it
            const port = 54323;
            const net = require('net');
            const server = net.createServer();

            // Bind to the port
            await new Promise<void>((resolve) => {
                server.listen(port, 'localhost', () => {
                    resolve();
                });
            });

            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const isPortAvailable = getPrivateMethod(serverStarter as any, 'isPortAvailable');
                const result = await isPortAvailable(port);

                // CRITICAL: Should return false because we're holding the port
                assert.isFalse(result, 'Port should be detected as in use when actually bound');
            } finally {
                // Clean up: close the server
                await new Promise<void>((resolve) => {
                    server.close(() => resolve());
                });
            }
        });

        test('should detect when checking port availability', async () => {
            // This tests that isPortAvailable returns a boolean
            const port = 54322;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const isPortAvailable = getPrivateMethod(serverStarter as any, 'isPortAvailable');
            const result = await isPortAvailable(port);

            // Result should be a boolean
            assert.isBoolean(result);
        });
    });

    suite('findAvailablePort', () => {
        test('should find an available port starting from given port', async () => {
            const portsInUse = new Set<number>();
            const startPort = 54400;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const findAvailablePort = getPrivateMethod(serverStarter as any, 'findAvailablePort');
            const result = await findAvailablePort(startPort, portsInUse);

            // Should find a port at or after the start port
            assert.isAtLeast(result, startPort);
        });

        test('should skip ports in portsInUse set', async () => {
            const portsInUse = new Set<number>([54500, 54501, 54502]);
            const startPort = 54500;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const findAvailablePort = getPrivateMethod(serverStarter as any, 'findAvailablePort');
            const result = await findAvailablePort(startPort, portsInUse);

            // Should skip the ports in use
            assert.isFalse(portsInUse.has(result), 'Should not return a port from portsInUse');
            assert.isAtLeast(result, 54503);
        });

        test('should find available port within reasonable attempts', async () => {
            const portsInUse = new Set<number>();
            const startPort = 54600;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const findAvailablePort = getPrivateMethod(serverStarter as any, 'findAvailablePort');
            const result = await findAvailablePort(startPort, portsInUse);

            // Should find a port without error
            assert.isNumber(result);
            assert.isAtLeast(result, startPort);
        });
    });

    suite('allocatePorts - Consecutive Port Allocation (Critical Bug Fix)', () => {
        test('should allocate consecutive ports (LSP = Jupyter + 1)', async () => {
            const key = 'test-consecutive-1';

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');
            const result = await allocatePorts(key);

            // THIS IS THE CRITICAL ASSERTION: LSP port must be exactly Jupyter + 1
            assert.strictEqual(
                result.lspPort,
                result.jupyterPort + 1,
                'LSP port must be consecutive (Jupyter port + 1)'
            );
        });

        test('should allocate different consecutive port pairs for multiple servers', async () => {
            const key1 = 'test-server-1';
            const key2 = 'test-server-2';

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');

            const result1 = await allocatePorts(key1);
            const result2 = await allocatePorts(key2);

            // Both should have consecutive ports
            assert.strictEqual(result1.lspPort, result1.jupyterPort + 1);
            assert.strictEqual(result2.lspPort, result2.jupyterPort + 1);

            // Ports should not overlap
            assert.notEqual(result1.jupyterPort, result2.jupyterPort);
            assert.notEqual(result1.lspPort, result2.lspPort);
            assert.notEqual(result1.jupyterPort, result2.lspPort);
            assert.notEqual(result1.lspPort, result2.jupyterPort);
        });

        test('CRITICAL REGRESSION TEST: should skip non-consecutive ports when LSP port is taken', async () => {
            // This test simulates the EXACT bug scenario that was reported:
            // - Port 8888 is available
            // - Port 8889 (8888+1) is TAKEN by another process
            // - System should NOT allocate 8888+8890 (non-consecutive)
            // - System SHOULD find a different consecutive pair like 8890+8891

            const net = require('net');
            const blockingServer = net.createServer();
            const blockedPort = 54701; // We'll block this port to simulate 8889 being taken

            // Bind to port 54701 to block it
            await new Promise<void>((resolve) => {
                blockingServer.listen(blockedPort, 'localhost', () => {
                    resolve();
                });
            });

            try {
                const key = 'test-blocked-lsp-port';

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');

                // Try to allocate ports - it should skip 54700 because 54701 is taken
                const result = await allocatePorts(key);

                // CRITICAL: Ports must be consecutive
                assert.strictEqual(
                    result.lspPort,
                    result.jupyterPort + 1,
                    'Even when some ports are blocked, allocated ports MUST be consecutive'
                );

                // Should not have allocated the blocked port or its predecessor
                assert.notEqual(result.jupyterPort, blockedPort);
                assert.notEqual(result.lspPort, blockedPort);
                assert.isFalse(
                    result.jupyterPort === blockedPort - 1 && result.lspPort === blockedPort,
                    'Should not allocate pair where second port is blocked'
                );
            } finally {
                // Clean up: close the blocking server
                await new Promise<void>((resolve) => {
                    blockingServer.close(() => resolve());
                });
            }
        });

        test('should handle rapid sequential allocations', async () => {
            const keys = ['seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5'];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');

            const results = [];
            for (const key of keys) {
                const result = await allocatePorts(key);
                results.push(result);
            }

            // All should have unique, consecutive port pairs
            const allPorts = results.flatMap((r) => [r.jupyterPort, r.lspPort]);
            const uniquePorts = new Set(allPorts);
            assert.strictEqual(uniquePorts.size, results.length * 2, 'All ports should be unique');

            // Each result should have consecutive ports
            for (const result of results) {
                assert.strictEqual(result.lspPort, result.jupyterPort + 1);
            }
        });

        test('should update serverInfos map with allocated ports', async () => {
            const key = 'test-server-info';

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');
            const result = await allocatePorts(key);

            // Check that serverInfos was updated
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const serverInfos = (serverStarter as any).serverInfos as Map<string, any>;
            assert.isTrue(serverInfos.has(key));

            const info = serverInfos.get(key);
            assert.strictEqual(info.jupyterPort, result.jupyterPort);
            assert.strictEqual(info.lspPort, result.lspPort);
            assert.strictEqual(info.url, `http://localhost:${result.jupyterPort}`);
        });

        test('should respect already allocated ports', async () => {
            // First allocation
            const key1 = 'first-server';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');
            const result1 = await allocatePorts(key1);

            // Second allocation should get different ports
            const key2 = 'second-server';
            const result2 = await allocatePorts(key2);

            // Verify no overlap
            const ports1 = new Set([result1.jupyterPort, result1.lspPort]);
            assert.isFalse(ports1.has(result2.jupyterPort), 'Second Jupyter port should not overlap');
            assert.isFalse(ports1.has(result2.lspPort), 'Second LSP port should not overlap');
        });
    });

    suite('Port Allocation Edge Cases', () => {
        test('should allocate ports successfully even after multiple allocations', async () => {
            // Allocate many port pairs to test robustness
            const count = 10;
            const keys = Array.from({ length: count }, (_, i) => `stress-test-${i}`);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');

            const results = [];
            for (const key of keys) {
                const result = await allocatePorts(key);
                results.push(result);
            }

            // All should be successful and consecutive
            assert.strictEqual(results.length, count);
            for (const result of results) {
                assert.strictEqual(result.lspPort, result.jupyterPort + 1);
            }

            // All ports should be unique
            const allPorts = results.flatMap((r) => [r.jupyterPort, r.lspPort]);
            const uniquePorts = new Set(allPorts);
            assert.strictEqual(uniquePorts.size, count * 2);
        });

        test('should return valid port numbers', async () => {
            const key = 'valid-ports';

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');
            const result = await allocatePorts(key);

            // Ports should be in valid range
            assert.isAtLeast(result.jupyterPort, 1024, 'Port should be above well-known ports');
            assert.isBelow(result.jupyterPort, 65536, 'Port should be below max port number');
            assert.isAtLeast(result.lspPort, 1024);
            assert.isBelow(result.lspPort, 65536);
        });
    });

    suite('Critical Bug Fix Verification', () => {
        test('REGRESSION TEST: should never allocate non-consecutive ports', async () => {
            // This is the critical regression test for the bug where
            // if Jupyter port was available but LSP port (Jupyter+1) was not,
            // the system would allocate non-consecutive ports causing server hangs

            const keys = ['regression-1', 'regression-2', 'regression-3'];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const allocatePorts = getPrivateMethod(serverStarter as any, 'allocatePorts');

            const results = await Promise.all(keys.map((key) => allocatePorts(key)));

            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                assert.strictEqual(
                    result.lspPort,
                    result.jupyterPort + 1,
                    `Server ${i + 1} (${keys[i]}): LSP port MUST be Jupyter port + 1. ` +
                        `This prevents server startup hangs when toolkit expects consecutive ports.`
                );
            }
        });
    });
});
