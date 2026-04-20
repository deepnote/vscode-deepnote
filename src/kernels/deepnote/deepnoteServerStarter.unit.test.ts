import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import esmock from 'esmock';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { createMockChildProcess } from './deepnoteTestHelpers.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { IDeepnoteToolkitInstaller } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';

/**
 * Unit tests for DeepnoteServerStarter.
 *
 * Port allocation, server spawning, and health checks are delegated to
 * @deepnote/runtime-core's startServer/stopServer. These tests focus on the
 * extension-specific layers: SQL env var gathering, lifecycle orchestration,
 * and project-id keyed reuse of a single server across sibling files.
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
            const result = await gatherEnvVars(Uri.file('/test/file.deepnote'), 'env1');

            assert.deepStrictEqual(result, {});

            await starterWithoutSql.dispose();
        });

        test('should return empty object when provider rejects with cancellation error', async () => {
            const { CancellationError } = await import('vscode');

            const cancelledProvider = mock<ISqlIntegrationEnvVarsProvider>();
            when(cancelledProvider.getEnvironmentVariables(anything(), anything())).thenReject(new CancellationError());

            const starterWithCancelledSql = new DeepnoteServerStarter(
                instance(mockProcessServiceFactory),
                instance(mockToolkitInstaller),
                instance(mockAgentSkillsManager),
                instance(mockOutputChannel),
                instance(mockAsyncRegistry),
                instance(cancelledProvider)
            );

            const gatherEnvVars = getPrivateMethod(starterWithCancelledSql, 'gatherSqlIntegrationEnvVars');
            const result = await gatherEnvVars(Uri.file('/test/file.deepnote'), 'env1');

            assert.deepStrictEqual(result, {});

            await starterWithCancelledSql.dispose();
        });
    });

    suite('dispose', () => {
        let clock: fakeTimers.InstalledClock;

        setup(() => {
            clock = fakeTimers.install();
        });

        teardown(() => {
            clock.uninstall();
        });

        test('should clear all internal state', async () => {
            await serverStarter.dispose();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const starter = serverStarter as any;
            assert.strictEqual(starter.disposablesByFile.size, 0);
            assert.strictEqual(starter.pendingOperations.size, 0);
            assert.strictEqual(starter.projectContexts.size, 0);
            assert.strictEqual(starter.serverOutputByFile.size, 0);
        });

        test('should wait for in-flight pending operations before completing', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const starter = serverStarter as any;

            let resolveDeferred!: () => void;
            const deferred = new Promise<void>((resolve) => {
                resolveDeferred = resolve;
            });

            // Internal maps are now keyed by projectId, not fsPath
            starter.pendingOperations.set('project-id-inflight', {
                type: 'stop',
                promise: deferred
            });

            let disposeResolved = false;
            const disposePromise = serverStarter.dispose().then(() => {
                disposeResolved = true;
            });

            await clock.tickAsync(0);
            assert.strictEqual(
                disposeResolved,
                false,
                'dispose() should not resolve while a pending operation is in flight'
            );

            resolveDeferred();
            await clock.tickAsync(0);
            await disposePromise;

            assert.strictEqual(disposeResolved, true, 'dispose() should resolve after pending operation completes');
            assert.strictEqual(starter.pendingOperations.size, 0);
        });
    });

    /**
     * Verifies the core plan invariant: two sibling `.deepnote` files that share
     * the same `projectId` must reuse a single underlying server process. We
     * assert this by mocking `@deepnote/runtime-core`'s `startServer` and
     * checking it's only called once, even though `startServer` is invoked
     * twice with different `deepnoteFileUri`s but the same `projectId`.
     */
    suite('shared server for siblings with same projectId', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let mockedStarterModule: any;
        let runtimeCoreStartServer: sinon.SinonStub;
        let runtimeCoreStopServer: sinon.SinonStub;
        let localFetchStub: sinon.SinonStub;

        setup(async () => {
            runtimeCoreStartServer = sinon.stub();
            runtimeCoreStopServer = sinon.stub().resolves();

            mockedStarterModule = await esmock('./deepnoteServerStarter.node', {
                '@deepnote/runtime-core': {
                    startServer: runtimeCoreStartServer,
                    stopServer: runtimeCoreStopServer
                }
            });

            // Stub fetch so the existing-server health check path is testable.
            localFetchStub = sinon.stub(globalThis, 'fetch');
        });

        teardown(() => {
            localFetchStub?.restore();
            esmock.purge(mockedStarterModule);
        });

        test('two deepnoteFileUris sharing one projectId reuse a single server', async () => {
            const toolkitInstaller = mock<IDeepnoteToolkitInstaller>();
            when(toolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything(), anything())).thenResolve({
                pythonInterpreter: {
                    id: '/venvs/env1/bin/python',
                    uri: Uri.file('/venvs/env1/bin/python')
                } as PythonEnvironment,
                toolkitVersion: '2.0.0'
            });
            when(toolkitInstaller.installAdditionalPackages(anything(), anything(), anything())).thenResolve();

            const agentSkillsManager = mock<DeepnoteAgentSkillsManager>();
            when(agentSkillsManager.ensureSkillsUpdated(anything(), anything())).thenReturn();

            const outputChannel = mock<IOutputChannel>();
            when(outputChannel.appendLine(anything())).thenReturn();

            const processServiceFactory = mock<IProcessServiceFactory>();
            const asyncRegistry = mock<IAsyncDisposableRegistry>();
            when(asyncRegistry.push(anything())).thenReturn();

            const mockedProcess = createMockChildProcess({ pid: 12345 });

            const firstServerInfo = {
                url: 'http://localhost:8899',
                jupyterPort: 8899,
                lspPort: 8900,
                process: mockedProcess
            };

            runtimeCoreStartServer.resolves(firstServerInfo);

            // Force `isServerRunning` to return true on the second call, so the
            // existing server context is reused instead of restarted.
            localFetchStub.resolves({ ok: true });

            const StarterCtor = mockedStarterModule.DeepnoteServerStarter;
            const starter = new StarterCtor(
                instance(processServiceFactory),
                instance(toolkitInstaller),
                instance(agentSkillsManager),
                instance(outputChannel),
                instance(asyncRegistry)
            );

            try {
                const interpreter = {
                    id: '/usr/bin/python3',
                    uri: Uri.file('/usr/bin/python3')
                } as PythonEnvironment;

                const venvPath = Uri.file('/venvs/env1');
                const projectId = 'shared-project-id';

                // Sibling 1: file A sharing the project
                const resultA = await starter.startServer(
                    interpreter,
                    venvPath,
                    true, // managedVenv
                    [], // additionalPackages
                    'env1', // environmentId
                    projectId,
                    Uri.file('/workspace/a.deepnote')
                );

                // Sibling 2: file B sharing the SAME projectId
                const resultB = await starter.startServer(
                    interpreter,
                    venvPath,
                    true,
                    [],
                    'env1',
                    projectId,
                    Uri.file('/workspace/b.deepnote')
                );

                assert.strictEqual(
                    runtimeCoreStartServer.callCount,
                    1,
                    'Underlying @deepnote/runtime-core startServer should only be invoked once for two siblings sharing a projectId'
                );
                assert.strictEqual(resultA, firstServerInfo);
                assert.strictEqual(resultB, firstServerInfo, 'Second call should return the same ServerInfo');

                // Only one project context should exist, keyed by projectId
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const projectContexts = (starter as any).projectContexts as Map<string, unknown>;
                assert.strictEqual(projectContexts.size, 1);
                assert.strictEqual(projectContexts.has(projectId), true);
            } finally {
                await starter.dispose();
            }
        });
    });
});
