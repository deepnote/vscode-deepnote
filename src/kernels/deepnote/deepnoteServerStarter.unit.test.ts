import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { CancellationError, CancellationToken, Uri } from 'vscode';

import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IDisposable, IOutputChannel } from '../../platform/common/types';
import { DeepnoteServerInfo, IDeepnoteToolkitInstaller } from './types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';

/**
 * Accessor for the @deepnote/runtime-core mock's test-only helpers (see build/mocha-esm-loader.js).
 * The real .d.ts does not declare these, so we reach them through a dynamic import + cast.
 */
interface RuntimeCoreMockHelpers {
    __getStartServerCalls(): Array<{ workingDirectory: string; pythonEnv: string; env?: Record<string, string> }>;
    __getStopServerCalls(): unknown[];
    __setStartServerImpl(impl: ((options: unknown) => Promise<unknown>) | null): void;
    __resetRuntimeCoreMock(): void;
}

async function getRuntimeCoreMock(): Promise<RuntimeCoreMockHelpers> {
    return (await import('@deepnote/runtime-core')) as unknown as RuntimeCoreMockHelpers;
}

type PendingOperation =
    | { type: 'start'; promise: Promise<DeepnoteServerInfo> }
    | { type: 'stop'; promise: Promise<void> };

interface ProjectContext {
    environmentId: string;
    serverInfo: DeepnoteServerInfo | null;
}

/**
 * Structural mirror of DeepnoteServerStarter's private surface (deepnoteServerStarter.node.ts).
 * `internals` is the single typed seam for reaching private state in these tests.
 */
interface DeepnoteServerStarterInternals {
    readonly disposablesByFile: Map<string, IDisposable[]>;
    readonly pendingOperations: Map<string, PendingOperation>;
    readonly projectContexts: Map<string, ProjectContext>;
    readonly serverOutputByFile: Map<string, { stdout: string; stderr: string }>;
    gatherSqlIntegrationEnvVars(
        deepnoteFileUri: Uri,
        environmentId: string,
        token?: CancellationToken
    ): Promise<Record<string, string>>;
    isServerRunning(serverInfo: DeepnoteServerInfo): Promise<boolean>;
}

function internals(starter: DeepnoteServerStarter): DeepnoteServerStarterInternals {
    return starter as unknown as DeepnoteServerStarterInternals;
}

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
        sinon.restore();
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

            const result = await internals(starterWithoutSql).gatherSqlIntegrationEnvVars(
                Uri.file('/test/file.deepnote'),
                'env1'
            );

            assert.deepStrictEqual(result, {});

            await starterWithoutSql.dispose();
        });

        test('should return empty object when provider rejects with cancellation error', async () => {
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

            const result = await internals(starterWithCancelledSql).gatherSqlIntegrationEnvVars(
                Uri.file('/test/file.deepnote'),
                'env1'
            );

            assert.deepStrictEqual(result, {});

            await starterWithCancelledSql.dispose();
        });
    });

    suite('per-notebook keying (startServer/stopServer)', () => {
        const interpreter: PythonEnvironment = {
            id: '/usr/bin/python3',
            uri: Uri.file('/usr/bin/python3')
        };
        const venvPath = Uri.file('/venvs/env1');
        // Two notebooks in the SAME project directory but different files (sibling files).
        const uriA = Uri.file('/workspace/project/notebook-a.deepnote');
        const uriB = Uri.file('/workspace/project/notebook-b.deepnote');

        const start = (notebookUri: Uri, environmentId = 'env1') =>
            serverStarter.startServer(interpreter, venvPath, true, [], environmentId, notebookUri);

        setup(async () => {
            const runtimeCore = await getRuntimeCoreMock();
            runtimeCore.__resetRuntimeCoreMock();

            // The toolkit install step runs before runtime-core's startServer; stub it so the
            // start path reaches startServer. (Un-stubbed ts-mockito methods return null.)
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything(), anything())).thenResolve(
                {
                    pythonInterpreter: interpreter,
                    toolkitVersion: '1.0.0'
                }
            );
            when(mockToolkitInstaller.installAdditionalPackages(anything(), anything(), anything())).thenResolve();
            when(mockAgentSkillsManager.ensureSkillsUpdated(anything(), anything())).thenReturn();
        });

        test('starts SEPARATE servers for two different notebook URIs in the same dir (catches cross-sibling server reuse)', async () => {
            const runtimeCore = await getRuntimeCoreMock();

            const infoA = await start(uriA);
            const infoB = await start(uriB);

            // runtime-core startServer must be invoked once per notebook — NOT reused across siblings.
            const calls = runtimeCore.__getStartServerCalls();
            assert.strictEqual(calls.length, 2, 'each distinct notebook URI must spawn its own server process');

            // The two servers are distinct (distinct map entries / distinct ServerInfo).
            assert.notStrictEqual(infoA.url, infoB.url, 'sibling notebooks must not share one server');

            // Each server uses dirname(its own notebookUri.fsPath) as working directory.
            // Both files share the same parent dir, so both servers use that dir as cwd.
            assert.strictEqual(calls[0].workingDirectory, '/workspace/project');
            assert.strictEqual(calls[1].workingDirectory, '/workspace/project');

            // Two distinct projectContexts keyed by notebook.uri.fsPath.
            const contexts = internals(serverStarter).projectContexts;
            assert.strictEqual(contexts.size, 2, 'one project context per notebook URI');
            assert.isTrue(contexts.has(uriA.fsPath), 'context keyed by notebook A URI');
            assert.isTrue(contexts.has(uriB.fsPath), 'context keyed by notebook B URI');
        });

        test('REUSES the running server when the SAME notebook URI re-requests the same environment (catches redundant respawn)', async () => {
            const runtimeCore = await getRuntimeCoreMock();

            // Stub the running-server health probe to report "running" so the reuse branch is taken.
            sinon.stub(internals(serverStarter), 'isServerRunning').resolves(true);

            const first = await start(uriA);
            assert.strictEqual(runtimeCore.__getStartServerCalls().length, 1);

            const second = await start(uriA);

            assert.strictEqual(
                runtimeCore.__getStartServerCalls().length,
                1,
                'a second start for the same notebook+environment must reuse the server, not respawn'
            );
            assert.strictEqual(second.url, first.url, 'the reused server info must be returned');
        });

        test('stopServer(uriA) tears down ONLY notebook A; B keeps running (catches cross-notebook teardown)', async () => {
            const runtimeCore = await getRuntimeCoreMock();

            await start(uriA);
            await start(uriB);

            await serverStarter.stopServer(uriA);

            // runtime-core stopServer invoked exactly once (only A's process was alive and stopped).
            assert.strictEqual(runtimeCore.__getStopServerCalls().length, 1, 'only notebook A server stopped');

            const contexts = internals(serverStarter).projectContexts;
            // A's context still exists but its server is cleared; B's server is untouched.
            assert.strictEqual(contexts.get(uriA.fsPath)?.serverInfo, null, "A's server info cleared");
            assert.isNotNull(contexts.get(uriB.fsPath)?.serverInfo, "B's server must remain running");
        });

        test('stopServer for a notebook with NO running server is a safe no-op (does not throw, does not call runtime-core stop)', async () => {
            const runtimeCore = await getRuntimeCoreMock();

            // Never started anything for this URI.
            await serverStarter.stopServer(Uri.file('/workspace/project/never-started.deepnote'));

            assert.strictEqual(
                runtimeCore.__getStopServerCalls().length,
                0,
                'stopping a notebook with no server must not invoke runtime-core stopServer'
            );
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

            const starter = internals(serverStarter);
            assert.strictEqual(starter.disposablesByFile.size, 0);
            assert.strictEqual(starter.pendingOperations.size, 0);
            assert.strictEqual(starter.projectContexts.size, 0);
            assert.strictEqual(starter.serverOutputByFile.size, 0);
        });

        test('should wait for in-flight pending operations before completing', async () => {
            const starter = internals(serverStarter);

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
