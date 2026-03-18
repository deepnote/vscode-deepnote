import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import { anything, instance, mock, when } from 'ts-mockito';

import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { IDeepnoteToolkitInstaller } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';

/**
 * Unit tests for DeepnoteServerStarter.
 *
 * Port allocation, server spawning, and health checks are delegated to
 * @deepnote/runtime-core's startServer/stopServer. These tests focus on the
 * extension-specific layers: SQL env var gathering and lifecycle orchestration.
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
            const { Uri } = await import('vscode');
            const result = await gatherEnvVars(Uri.file('/test/file.deepnote'), 'env1');

            assert.deepStrictEqual(result, {});

            await starterWithoutSql.dispose();
        });

        test('should return empty object when provider rejects with cancellation error', async () => {
            const { CancellationError, Uri } = await import('vscode');

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

            starter.pendingOperations.set('/test/inflight.deepnote', {
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
});
