import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';

import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { createMockChildProcess } from './deepnoteTestHelpers.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { IDeepnoteToolkitInstaller } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';

/**
 * Unit tests for DeepnoteServerStarter.
 *
 * Port allocation, server spawning, and health checks are now delegated to
 * @deepnote/runtime-core's startServer/stopServer. These tests focus on the
 * extension-specific layers: port reservation serialization, SQL env var
 * gathering, and lifecycle orchestration.
 */
suite('DeepnoteServerStarter', () => {
    let serverStarter: DeepnoteServerStarter;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockToolkitInstaller: IDeepnoteToolkitInstaller;
    let mockAgentSkillsManager: DeepnoteAgentSkillsManager;
    let mockOutputChannel: IOutputChannel;
    let mockAsyncRegistry: IAsyncDisposableRegistry;
    let mockSqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getPrivateMethod = (obj: any, methodName: string) => {
        return obj[methodName].bind(obj);
    };

    setup(() => {
        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockToolkitInstaller = mock<IDeepnoteToolkitInstaller>();
        mockAgentSkillsManager = mock<DeepnoteAgentSkillsManager>();
        mockOutputChannel = mock<IOutputChannel>();
        mockAsyncRegistry = mock<IAsyncDisposableRegistry>();
        mockSqlIntegrationEnvVars = mock<ISqlIntegrationEnvVarsProvider>();

        when(mockAsyncRegistry.push(anything())).thenReturn();
        when(mockOutputChannel.appendLine(anything())).thenReturn();

        serverStarter = new DeepnoteServerStarter(
            instance(mockProcessServiceFactory),
            instance(mockToolkitInstaller),
            instance(mockAgentSkillsManager),
            instance(mockOutputChannel),
            instance(mockAsyncRegistry),
            instance(mockSqlIntegrationEnvVars)
        );
    });

    teardown(async () => {
        if (serverStarter) {
            await serverStarter.dispose();
        }
    });

    suite('reserveStartPort - Port Serialization', () => {
        test('should return default port when no servers are running', async () => {
            const reserveStartPort = getPrivateMethod(serverStarter, 'reserveStartPort');
            const port = await reserveStartPort('test-key');

            assert.strictEqual(port, 8888);
        });

        test('should return ports beyond existing servers', async () => {
            const reserveStartPort = getPrivateMethod(serverStarter, 'reserveStartPort');

            // Simulate a running server context by directly setting projectContexts
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const projectContexts = (serverStarter as any).projectContexts as Map<string, any>;
            projectContexts.set('existing-key', {
                environmentId: 'env1',
                serverInfo: {
                    url: 'http://localhost:8888',
                    jupyterPort: 8888,
                    lspPort: 8889,
                    process: createMockChildProcess()
                }
            });

            const port = await reserveStartPort('test-key-2');

            assert.isAtLeast(port, 8890, 'Should skip ports used by existing servers');
        });

        test('should serialize concurrent calls', async () => {
            const reserveStartPort = getPrivateMethod(serverStarter, 'reserveStartPort');

            // Launch concurrent port reservations
            const [port1, port2, port3] = await Promise.all([
                reserveStartPort('key-1'),
                reserveStartPort('key-2'),
                reserveStartPort('key-3')
            ]);

            // All should return valid numbers (even if same, since no server info is stored between calls)
            assert.isNumber(port1);
            assert.isNumber(port2);
            assert.isNumber(port3);
        });
    });

    suite('gatherSqlIntegrationEnvVars', () => {
        test('should return empty object when no provider is available', async () => {
            // Create a starter without SQL provider
            const starterWithoutSql = new DeepnoteServerStarter(
                instance(mockProcessServiceFactory),
                instance(mockToolkitInstaller),
                instance(mockAgentSkillsManager),
                instance(mockOutputChannel),
                instance(mockAsyncRegistry)
            );

            const gatherEnvVars = getPrivateMethod(starterWithoutSql, 'gatherSqlIntegrationEnvVars');
            const { Uri } = await import('vscode');
            const result = await gatherEnvVars(Uri.file('/test/file.deepnote'), 'env1');

            assert.deepStrictEqual(result, {});

            await starterWithoutSql.dispose();
        });
    });

    suite('dispose', () => {
        test('should clear all internal state', async () => {
            await serverStarter.dispose();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const starter = serverStarter as any;
            assert.strictEqual(starter.projectContexts.size, 0);
            assert.strictEqual(starter.disposablesByFile.size, 0);
            assert.strictEqual(starter.pendingOperations.size, 0);
        });
    });
});
