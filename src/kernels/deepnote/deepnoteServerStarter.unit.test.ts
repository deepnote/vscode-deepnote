import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { serializeDeepnoteFile } from '@deepnote/blocks';

import { createDeepnoteFile, createDeepnoteProject } from '../../notebooks/deepnote/deepnoteTestHelpers';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { IUserpodApiEndpoints } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import {
    __getStartServerCalls,
    __getStopServerCalls,
    __resetRuntimeCoreMock
} from '../../test/mocks/deepnoteRuntimeCore';
import { stubReadFile } from '../../test/mocks/vscodeFs';
import { resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IDeepnoteToolkitInstaller } from './types';

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
    const venvPath = Uri.file('/venvs/env1');
    // Two notebooks in the SAME project directory but different files (sibling files).
    const uriA = Uri.file('/workspace/project/notebook-a.deepnote');
    const uriB = Uri.file('/workspace/project/notebook-b.deepnote');

    let serverStarter: DeepnoteServerStarter;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockToolkitInstaller: IDeepnoteToolkitInstaller;
    let mockAgentSkillsManager: DeepnoteAgentSkillsManager;
    let mockOutputChannel: IOutputChannel;
    let mockAsyncRegistry: IAsyncDisposableRegistry;
    let mockUserpodApiEndpoints: IUserpodApiEndpoints;

    setup(() => {
        __resetRuntimeCoreMock();
        resetVSCodeMocks();

        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockToolkitInstaller = mock<IDeepnoteToolkitInstaller>();
        mockAgentSkillsManager = mock<DeepnoteAgentSkillsManager>();
        mockOutputChannel = mock<IOutputChannel>();
        mockAsyncRegistry = mock<IAsyncDisposableRegistry>();
        mockUserpodApiEndpoints = mock<IUserpodApiEndpoints>();

        when(mockAsyncRegistry.push(anything())).thenReturn();
        when(mockOutputChannel.appendLine(anything())).thenReturn();

        when(mockUserpodApiEndpoints.ready).thenReturn(Promise.resolve());
        when(mockUserpodApiEndpoints.baseUrl).thenReturn(undefined);

        // The toolkit install step runs before runtime-core's startServer; stub it so the
        // start path reaches startServer. (ts-mockito methods that are not stubbed return null.)
        when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything(), anything())).thenResolve({
            pythonInterpreter: interpreter,
            toolkitVersion: '1.0.0'
        });
        when(mockToolkitInstaller.installAdditionalPackages(anything(), anything(), anything())).thenResolve();
        when(mockAgentSkillsManager.ensureSkillsUpdated(anything(), anything())).thenReturn();

        serverStarter = new DeepnoteServerStarter(
            instance(mockProcessServiceFactory),
            instance(mockToolkitInstaller),
            instance(mockAgentSkillsManager),
            instance(mockOutputChannel),
            instance(mockAsyncRegistry),
            instance(mockUserpodApiEndpoints)
        );
    });

    teardown(async () => {
        sinon.restore();
        await serverStarter.dispose();
    });

    function serializeProjectFile(projectId: string): string {
        return serializeDeepnoteFile(createDeepnoteFile({ project: createDeepnoteProject({ id: projectId }) }));
    }

    suite('integration endpoint env vars', () => {
        // The empty-env paths (endpoint not listening, no project id) belong to applyIntegrationEndpointEnv
        // and are covered by deepnoteIntegrationEndpointEnv.unit.test.ts; these tests cover the wiring only.
        test('forwards the integration endpoint env vars into the started server', async () => {
            stubReadFile(serializeProjectFile('the-project-id'));
            when(mockUserpodApiEndpoints.baseUrl).thenReturn('http://127.0.0.1:5555');
            when(mockUserpodApiEndpoints.getAuthToken(anything())).thenReturn('endpoint-token');

            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);

            assert.deepStrictEqual(
                __getStartServerCalls().map((c) => c.env),
                [
                    {
                        DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED: 'true',
                        DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE: 'true',
                        DEEPNOTE_RUNTIME__WEBAPP_URL: 'http://127.0.0.1:5555',
                        DEEPNOTE_RUNTIME__PROJECT_SECRET: 'endpoint-token',
                        DEEPNOTE_PROJECT_ID: 'the-project-id'
                    }
                ]
            );
        });

        test('does NOT leak one project id or bearer token into a sibling notebook server', async () => {
            // Sibling files in the same directory resolving to DIFFERENT projects, each with its own token.
            stubReadFile((uri) =>
                uri.toString() === uriA.toString()
                    ? serializeProjectFile('project-a')
                    : serializeProjectFile('project-b')
            );
            when(mockUserpodApiEndpoints.baseUrl).thenReturn('http://127.0.0.1:5555');
            when(mockUserpodApiEndpoints.getAuthToken('project-a')).thenReturn('token-a');
            when(mockUserpodApiEndpoints.getAuthToken('project-b')).thenReturn('token-b');

            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriB);

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

    suite('per-notebook keying (startServer/stopServer)', () => {
        test('starts SEPARATE servers for two different notebook URIs in the same dir (catches cross-sibling server reuse)', async () => {
            const infoA = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            const infoB = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriB);

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

            const first = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            const second = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);

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

        test('spawns a FRESH server when the same notebook starts again after stopServer (catches stale server-info reuse)', async () => {
            // Health probes report "running" for everything; a stopped notebook must still respawn.
            sinon.stub(globalThis, 'fetch').resolves(new Response());

            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            await serverStarter.stopServer(uriA);
            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);

            assert.strictEqual(__getStartServerCalls().length, 2, 'restart after stop must spawn a new server');
        });

        test('stopServer(uriA) tears down ONLY notebook A; B keeps running (catches cross-notebook teardown)', async () => {
            const infoA = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriB);

            await serverStarter.stopServer(uriA);

            assert.deepStrictEqual(__getStopServerCalls(), [infoA], "only notebook A's server must be stopped");
        });

        test('stopServer for a notebook with NO running server is a safe no-op (does not throw, does not call runtime-core stop)', async () => {
            // Never started anything for this URI.
            await serverStarter.stopServer(Uri.file('/workspace/project/never-started.deepnote'));

            assert.strictEqual(
                __getStopServerCalls().length,
                0,
                'stopping a notebook with no server must not invoke runtime-core stopServer'
            );
        });
    });

    suite('dispose', () => {
        test('stops every running server; a second dispose is a no-op', async () => {
            const infoA = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            const infoB = await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriB);

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

                const startPromise = serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);

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
