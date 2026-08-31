import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { serializeProjectFile } from '../../notebooks/deepnote/deepnoteTestHelpers';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { PythonExtension } from '@vscode/python-extension';
import { setPythonApi } from '../../platform/interpreter/helpers';
import { IUserpodApiEndpoints } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import {
    __getStartServerCalls,
    __getStopServerCalls,
    __resetRuntimeCoreMock,
    __setStopServerImpl
} from '../../test/mocks/deepnoteRuntimeCore';
import { stubReadFile } from '../../test/mocks/vscodeFs';
import { resolvableInstance } from '../../test/datascience/helpers';
import { resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';

/**
 * Unit tests for DeepnoteServerStarter.
 *
 * Port allocation, server spawning, and health checks are delegated to
 * @deepnote/runtime-core's startServer/stopServer, which the mocha loader swaps
 * for src/test/mocks/deepnoteRuntimeCore.ts. These tests drive the public API
 * and assert on the calls recorded by that mock — no private state access.
 */
suite('DeepnoteServerStarter', () => {
    const interpreter: PythonEnvironment = {
        id: '/usr/bin/python3',
        uri: Uri.file('/usr/bin/python3')
    };
    const otherInterpreter: PythonEnvironment = {
        id: '/envs/other/bin/python',
        uri: Uri.file('/envs/other/bin/python')
    };
    // Two notebooks in the SAME project directory but different files (sibling files).
    const uriA = Uri.file('/workspace/project/notebook-a.deepnote');
    const uriB = Uri.file('/workspace/project/notebook-b.deepnote');

    let serverStarter: DeepnoteServerStarter;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockAgentSkillsManager: DeepnoteAgentSkillsManager;
    let mockOutputChannel: IOutputChannel;
    let mockAsyncRegistry: IAsyncDisposableRegistry;
    let mockUserpodApiEndpoints: IUserpodApiEndpoints;

    setup(() => {
        __resetRuntimeCoreMock();
        resetVSCodeMocks();

        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockAgentSkillsManager = mock<DeepnoteAgentSkillsManager>();
        mockOutputChannel = mock<IOutputChannel>();
        mockAsyncRegistry = mock<IAsyncDisposableRegistry>();
        mockUserpodApiEndpoints = mock<IUserpodApiEndpoints>();

        when(mockAsyncRegistry.push(anything())).thenReturn();
        when(mockOutputChannel.appendLine(anything())).thenReturn();
        when(mockUserpodApiEndpoints.ready).thenReturn(Promise.resolve());
        when(mockUserpodApiEndpoints.baseUrl).thenReturn(undefined);

        when(mockAgentSkillsManager.ensureSkillsUpdated(anything(), anything())).thenReturn();

        // startServer derives the env path via getCachedEnvironment, which needs the Python API.
        const mockedApi = mock<PythonExtension>();
        sinon.stub(PythonExtension, 'api').resolves(resolvableInstance(mockedApi));
        const environments = mock<PythonExtension['environments']>();
        when(mockedApi.environments).thenReturn(instance(environments));
        when(environments.known).thenReturn([]);
        setPythonApi(instance(mockedApi));

        serverStarter = new DeepnoteServerStarter(
            instance(mockProcessServiceFactory),
            instance(mockAgentSkillsManager),
            instance(mockOutputChannel),
            instance(mockAsyncRegistry),
            instance(mockUserpodApiEndpoints)
        );
    });

    teardown(async () => {
        setPythonApi(undefined as any);
        sinon.restore();
        await serverStarter.dispose();
    });

    suite('integration endpoint env vars', () => {
        // The env shape and the empty-env paths belong to applyIntegrationEndpointEnv and are covered by
        // deepnoteIntegrationEndpointEnv.unit.test.ts; this test covers the per-notebook wiring only.
        test('does NOT leak one project id or bearer token into a sibling notebook server', async () => {
            stubReadFile((uri) =>
                uri.toString() === uriA.toString()
                    ? serializeProjectFile('project-a')
                    : serializeProjectFile('project-b')
            );
            when(mockUserpodApiEndpoints.baseUrl).thenReturn('http://127.0.0.1:5555');
            when(mockUserpodApiEndpoints.getAuthToken('project-a')).thenReturn('token-a');
            when(mockUserpodApiEndpoints.getAuthToken('project-b')).thenReturn('token-b');

            await serverStarter.startServer(interpreter, uriA);
            await serverStarter.startServer(interpreter, uriB);

            assert.deepStrictEqual(
                __getStartServerCalls().map((c) => c.env),
                [
                    {
                        DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED: 'true',
                        DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE: 'true',
                        DEEPNOTE_RUNTIME__WEBAPP_URL: 'http://127.0.0.1:5555',
                        DEEPNOTE_RUNTIME__PROJECT_SECRET: 'token-a',
                        DEEPNOTE_PROJECT_ID: 'project-a'
                    },
                    {
                        DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED: 'true',
                        DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE: 'true',
                        DEEPNOTE_RUNTIME__WEBAPP_URL: 'http://127.0.0.1:5555',
                        DEEPNOTE_RUNTIME__PROJECT_SECRET: 'token-b',
                        DEEPNOTE_PROJECT_ID: 'project-b'
                    }
                ],
                "notebook B's server must carry ONLY project B's id and bearer token"
            );
        });
    });

    suite('per-notebook keying', () => {
        test('starts SEPARATE servers for two different notebook URIs in the same dir (catches cross-sibling server reuse)', async () => {
            const infoA = await serverStarter.startServer(interpreter, uriA);
            const infoB = await serverStarter.startServer(interpreter, uriB);

            // runtime-core startServer must be invoked once per notebook — NOT reused across siblings.
            const calls = __getStartServerCalls();
            assert.strictEqual(calls.length, 2, 'each distinct notebook URI must spawn its own server process');
            assert.notStrictEqual(infoA.url, infoB.url, 'sibling notebooks must not share one server');

            // Each server uses dirname(its own notebookUri.fsPath) as working directory.
            assert.deepStrictEqual(
                calls.map((c) => c.workingDirectory),
                ['/workspace/project', '/workspace/project']
            );
        });

        test('REUSES the running server when the SAME notebook URI re-requests the same environment (catches redundant respawn)', async () => {
            // Simulate a live server: the health probe (GET {url}/api) succeeds.
            const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response());

            const first = await serverStarter.startServer(interpreter, uriA);
            const second = await serverStarter.startServer(interpreter, uriA);

            assert.strictEqual(
                __getStartServerCalls().length,
                1,
                'a second start for the same notebook+environment must reuse the server, not respawn'
            );
            assert.strictEqual(second, first, 'the reused server info must be returned');
            assert.isTrue(
                fetchStub.calledOnceWith(`${first.url}/api`),
                'reuse must be gated on a health probe of that server'
            );
        });

        test('passes the interpreter executable to runtime-core, not a derived directory', async () => {
            await serverStarter.startServer(interpreter, uriA);

            assert.strictEqual(
                __getStartServerCalls()[0].pythonEnv,
                interpreter.uri.fsPath,
                'runtime-core resolves a directory by probing for a generic python; only the exact executable is safe'
            );
        });

        test('switching interpreter stops the old server and spawns a fresh one (catches stale server-info reuse)', async () => {
            // Health probes report "running" for everything; a different interpreter must still respawn.
            sinon.stub(globalThis, 'fetch').resolves(new Response());

            const first = await serverStarter.startServer(interpreter, uriA);
            await serverStarter.startServer(otherInterpreter, uriA);

            assert.strictEqual(__getStartServerCalls().length, 2, 'a different interpreter must spawn a new server');
            assert.deepStrictEqual(__getStopServerCalls(), [first], "the old interpreter's server must be stopped");
        });

        test('switching interpreter for notebook A leaves B running (catches cross-notebook teardown)', async () => {
            const infoA = await serverStarter.startServer(interpreter, uriA);
            await serverStarter.startServer(interpreter, uriB);

            await serverStarter.startServer(otherInterpreter, uriA);

            assert.deepStrictEqual(__getStopServerCalls(), [infoA], "only notebook A's server must be stopped");
        });

        test('two concurrent starts across an interpreter switch spawn ONE server (catches an untracked leaked server)', async () => {
            // Health probes report "running", so the joined caller reuses rather than respawning.
            sinon.stub(globalThis, 'fetch').resolves(new Response());

            const first = await serverStarter.startServer(interpreter, uriA);

            // Hold the teardown open so both callers sit inside the switch window at once.
            let releaseStop!: () => void;
            const stopped = new Promise<void>((resolve) => (releaseStop = resolve));
            __setStopServerImpl(() => stopped);

            const both = Promise.all([
                serverStarter.startServer(otherInterpreter, uriA),
                serverStarter.startServer(otherInterpreter, uriA)
            ]);

            releaseStop();
            const [a, b] = await both;
            __setStopServerImpl(null);

            assert.strictEqual(
                __getStartServerCalls().length,
                2,
                'the second caller must join the in-flight switch, not spawn a server nothing can stop'
            );
            assert.strictEqual(a, b, 'both callers must receive the same server');
            assert.notStrictEqual(a.url, first.url, 'the switch must produce a new server');
        });
    });

    suite('dispose', () => {
        test('stops every running server; a second dispose is a no-op', async () => {
            const infoA = await serverStarter.startServer(interpreter, uriA);
            const infoB = await serverStarter.startServer(interpreter, uriB);

            await serverStarter.dispose();
            await serverStarter.dispose();

            assert.deepStrictEqual(__getStopServerCalls(), [infoA, infoB], 'each server stopped exactly once');
        });

        suite('with fake timers', () => {
            let clock: fakeTimers.InstalledClock;

            setup(() => {
                clock = fakeTimers.install();
            });

            teardown(() => {
                clock.uninstall();
            });

            test('waits for an in-flight start operation before completing', async () => {
                // Park the start mid-flight: the integration endpoint's readiness settles only via releaseStart.
                let releaseStart!: () => void;
                when(mockUserpodApiEndpoints.ready).thenReturn(
                    new Promise<void>((resolve) => {
                        releaseStart = resolve;
                    })
                );

                const startPromise = serverStarter.startServer(interpreter, uriA);

                let disposeResolved = false;
                const disposePromise = serverStarter.dispose().then(() => {
                    disposeResolved = true;
                });

                await clock.tickAsync(0);
                assert.strictEqual(
                    disposeResolved,
                    false,
                    'dispose() should not resolve while a start operation is in flight'
                );

                releaseStart();
                const info = await startPromise;
                await disposePromise;

                assert.deepStrictEqual(__getStopServerCalls(), [info], 'dispose must stop the server it waited for');
            });
        });
    });
});
