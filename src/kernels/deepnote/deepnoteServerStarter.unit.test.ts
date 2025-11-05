import { assert } from 'chai';
import * as sinon from 'sinon';
import tcpPortUsed from 'tcp-port-used';
import { anything, instance, mock, when } from 'ts-mockito';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IHttpClient, IOutputChannel } from '../../platform/common/types';
import { IDeepnoteToolkitInstaller } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';
import { logger } from '../../platform/logging';

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
        let checkStub: sinon.SinonStub;

        setup(() => {
            checkStub = sinon.stub(tcpPortUsed, 'check');
        });

        teardown(() => {
            checkStub.restore();
        });

        test('should return true when both IPv4 and IPv6 loopbacks are free', async () => {
            const port = 54321;
            checkStub.onFirstCall().resolves(false); // IPv4
            checkStub.onSecondCall().resolves(false); // IPv6

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const isPortAvailable = getPrivateMethod(serverStarter as any, 'isPortAvailable');
            const result = await isPortAvailable(port);

            assert.isTrue(result, 'Expected port to be reported as available');
            assert.strictEqual(checkStub.callCount, 2, 'Should check both IPv4 and IPv6 loopbacks');
            assert.deepEqual(checkStub.getCall(0).args, [port, '127.0.0.1']);
            assert.deepEqual(checkStub.getCall(1).args, [port, '::1']);
        });

        test('should return false when IPv4 loopback is already in use', async () => {
            const port = 54322;
            checkStub.onFirstCall().resolves(true);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const isPortAvailable = getPrivateMethod(serverStarter as any, 'isPortAvailable');
            const result = await isPortAvailable(port);

            assert.isFalse(result, 'Expected port to be reported as in use');
            assert.strictEqual(checkStub.callCount, 1, 'IPv6 check should be skipped when IPv4 is busy');
        });

        test('should return false and log when port checks throw', async () => {
            const port = 54323;
            const error = new Error('check failed');
            checkStub.rejects(error);

            const warnStub = sinon.stub(logger, 'warn');

            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const isPortAvailable = getPrivateMethod(serverStarter as any, 'isPortAvailable');
                const result = await isPortAvailable(port);

                assert.isFalse(result, 'Expected port check to fail closed when an error occurs');
                assert.isTrue(warnStub.called, 'Expected warning to be logged when check fails');
            } finally {
                warnStub.restore();
            }
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

    suite('findConsecutiveAvailablePorts - Edge Cases', () => {
        test('should mark both ports unavailable and continue when consecutive port is taken', async () => {
            // This test covers the scenario where a candidate port is available
            // but the next port (candidate + 1) is not available.
            // The system should mark BOTH ports as unavailable in portsInUse and continue searching.

            const net = require('net');
            const server1 = net.createServer();
            const server2 = net.createServer();
            const blockedPort1 = 54801;
            const blockedPort2 = 54803;

            // Block ports 54801 and 54803 (leaving 54800 and 54802 available but not consecutive)
            await new Promise<void>((resolve) => {
                server1.listen(blockedPort1, 'localhost', () => {
                    server2.listen(blockedPort2, 'localhost', () => {
                        resolve();
                    });
                });
            });

            try {
                const portsInUse = new Set<number>();
                const startPort = 54800;

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const findConsecutiveAvailablePorts = getPrivateMethod(
                    serverStarter as any,
                    'findConsecutiveAvailablePorts'
                );

                // Should skip 54800 (since 54801 is blocked) and 54802 (since 54803 is blocked)
                // and find the next consecutive pair like 54804+54805
                const result = await findConsecutiveAvailablePorts(startPort, portsInUse);

                // Verify ports are consecutive
                assert.strictEqual(result.lspPort, result.jupyterPort + 1);

                // Should have found ports after the blocked ones
                assert.isTrue(
                    result.jupyterPort > blockedPort2 || result.jupyterPort < blockedPort1 - 1,
                    'Should skip blocked port ranges'
                );
            } finally {
                // Clean up
                await new Promise<void>((resolve) => {
                    server1.close(() => {
                        server2.close(() => resolve());
                    });
                });
            }
        });

        test('should throw DeepnoteServerStartupError when max attempts exhausted', async () => {
            // This test covers the scenario where we cannot find consecutive ports
            // after maxAttempts (100 attempts). This should throw a DeepnoteServerStartupError.

            const net = require('net');
            const servers: any[] = [];

            try {
                // Block a large range of ports to make it impossible to find consecutive pairs
                const startPort = 55000;
                const portsToBlock = 210; // More than maxAttempts (100) * 2

                // Create servers blocking many ports
                for (let i = 0; i < portsToBlock; i++) {
                    const server = net.createServer();
                    servers.push(server);
                    await new Promise<void>((resolve) => {
                        server.listen(startPort + i, 'localhost', () => resolve());
                    });
                }

                const portsInUse = new Set<number>();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const findConsecutiveAvailablePorts = getPrivateMethod(
                    serverStarter as any,
                    'findConsecutiveAvailablePorts'
                );

                // Should throw DeepnoteServerStartupError after maxAttempts
                let errorThrown = false;
                try {
                    await findConsecutiveAvailablePorts(startPort, portsInUse);
                } catch (error: any) {
                    errorThrown = true;
                    assert.strictEqual(error.constructor.name, 'DeepnoteServerStartupError');
                    assert.include(error.stderr, 'Failed to find consecutive available ports');
                    assert.include(error.stderr, '100 attempts');
                }

                assert.isTrue(errorThrown, 'Expected DeepnoteServerStartupError to be thrown');
            } finally {
                // Clean up all servers
                await Promise.all(
                    servers.map(
                        (server) =>
                            new Promise<void>((resolve) => {
                                server.close(() => resolve());
                            })
                    )
                );
            }
        });
    });
});
