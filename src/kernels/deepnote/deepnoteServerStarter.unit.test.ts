import { assert } from 'chai';
import * as fakeTimers from '@sinonjs/fake-timers';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { CancellationError, Uri } from 'vscode';

import { serializeDeepnoteFile, type DeepnoteFile } from '@deepnote/blocks';

import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';
import { DeepnoteServerStarter } from './deepnoteServerStarter.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IAsyncDisposableRegistry, IOutputChannel } from '../../platform/common/types';
import { IDeepnoteToolkitInstaller } from './types';
import { IIntegrationsEnvVarsEndpoint } from '../../notebooks/deepnote/integrations/types';
import { ISqlIntegrationEnvVarsProvider } from '../../platform/notebooks/deepnote/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import {
    __getStartServerCalls,
    __getStopServerCalls,
    __resetRuntimeCoreMock
} from '../../test/mocks/deepnoteRuntimeCore';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';

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
    let mockSqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider;

    setup(() => {
        __resetRuntimeCoreMock();

        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockToolkitInstaller = mock<IDeepnoteToolkitInstaller>();
        mockAgentSkillsManager = mock<DeepnoteAgentSkillsManager>();
        mockOutputChannel = mock<IOutputChannel>();
        mockAsyncRegistry = mock<IAsyncDisposableRegistry>();
        mockSqlIntegrationEnvVars = mock<ISqlIntegrationEnvVarsProvider>();

        when(mockAsyncRegistry.push(anything())).thenReturn();
        when(mockOutputChannel.appendLine(anything())).thenReturn();

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
            instance(mockSqlIntegrationEnvVars)
        );
    });

    teardown(async () => {
        sinon.restore();
        await serverStarter.dispose();
    });

    suite('SQL integration env vars', () => {
        test('starts the server without SQL env vars when no provider is available', async () => {
            // The provider is @optional() — construct a starter without it.
            const starterWithoutSql = new DeepnoteServerStarter(
                instance(mockProcessServiceFactory),
                instance(mockToolkitInstaller),
                instance(mockAgentSkillsManager),
                instance(mockOutputChannel),
                instance(mockAsyncRegistry)
            );

            try {
                await starterWithoutSql.startServer(interpreter, venvPath, true, [], 'env1', uriA);

                assert.deepStrictEqual(
                    __getStartServerCalls().map((c) => c.env),
                    [{}]
                );
            } finally {
                await starterWithoutSql.dispose();
            }
        });

        test('starts the server without SQL env vars when the provider rejects with a cancellation error', async () => {
            when(mockSqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenReject(
                new CancellationError()
            );

            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);

            assert.deepStrictEqual(
                __getStartServerCalls().map((c) => c.env),
                [{}]
            );
        });

        test('forwards the SQL integration provider env vars into the started server', async () => {
            when(mockSqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({ FOO: 'bar' });

            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);

            assert.deepStrictEqual(
                __getStartServerCalls().map((c) => c.env),
                [{ FOO: 'bar' }]
            );
        });

        test('does NOT leak one notebook SQL env vars into a sibling whose provider yields none', async () => {
            // The provider is keyed by notebook URI: it yields env vars for A but nothing for its sibling B.
            when(mockSqlIntegrationEnvVars.getEnvironmentVariables(uriA, anything())).thenResolve({ FOO: 'bar' });
            when(mockSqlIntegrationEnvVars.getEnvironmentVariables(uriB, anything())).thenResolve({});

            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriA);
            await serverStarter.startServer(interpreter, venvPath, true, [], 'env1', uriB);

            assert.deepStrictEqual(
                __getStartServerCalls().map((c) => c.env),
                [{ FOO: 'bar' }, {}],
                "notebook B's server must NOT inherit A's SQL env vars"
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
                // Park the start mid-flight: its SQL env-var gathering resolves only via releaseStart.
                let releaseStart!: () => void;
                when(mockSqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenReturn(
                    new Promise((resolve) => {
                        releaseStart = () => resolve({});
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

    /**
     * Direct tests for the private `applyIntegrationEndpointEnv`, exercised via a cast so we mutate a
     * plain env object rather than intercepting the third-party `startServer`. The four integration env
     * vars are only injected when the loopback endpoint is listening AND the file resolves to a project
     * id; every other path degrades gracefully to whatever SQL_* vars were already gathered.
     */
    suite('applyIntegrationEndpointEnv (integration endpoint env injection)', () => {
        const projectFileUri = Uri.file('/workspace/project/notebook-a.deepnote');
        const baseUrl = 'http://127.0.0.1:5555';
        // A pre-seeded SQL_* var stands in for the env already gathered before the endpoint step runs.
        const sqlEnvKey = 'SQL_DEEPNOTE_INTEGRATION_ABC';
        const sqlEnvValue = 'postgres://localhost:5432/db';

        type WithApplyIntegrationEndpointEnv = {
            applyIntegrationEndpointEnv(extraEnv: Record<string, string>, deepnoteFileUri: Uri): Promise<void>;
        };

        // Starters built with an endpoint arg are tracked so each is disposed after its test.
        let extraStarters: DeepnoteServerStarter[];

        setup(() => {
            resetVSCodeMocks();
            extraStarters = [];
        });

        teardown(async () => {
            await Promise.all(extraStarters.map((starter) => starter.dispose()));
        });

        /**
         * Builds a starter wired with the integration endpoint (optional ctor arg at positional index 6),
         * whose `baseUrl` getter yields `endpointBaseUrl`. Tracked for disposal.
         */
        function createStarterWithEndpoint(endpointBaseUrl: string | undefined): DeepnoteServerStarter {
            const endpoint: IIntegrationsEnvVarsEndpoint = { baseUrl: endpointBaseUrl };
            const starter = new DeepnoteServerStarter(
                instance(mockProcessServiceFactory),
                instance(mockToolkitInstaller),
                instance(mockAgentSkillsManager),
                instance(mockOutputChannel),
                instance(mockAsyncRegistry),
                instance(mockSqlIntegrationEnvVars),
                endpoint
            );
            extraStarters.push(starter);

            return starter;
        }

        function applyIntegrationEndpointEnv(
            starter: DeepnoteServerStarter,
            extraEnv: Record<string, string>,
            deepnoteFileUri: Uri
        ): Promise<void> {
            return (starter as unknown as WithApplyIntegrationEndpointEnv).applyIntegrationEndpointEnv(
                extraEnv,
                deepnoteFileUri
            );
        }

        /**
         * Stubs `workspace.fs.readFile` — the read behind `resolveProjectIdForFile` — to yield the
         * serialized `.deepnote` bytes. Returns the mock so tests can assert whether the read happened.
         */
        function stubReadFile(fileContents: string): typeof import('vscode').workspace.fs {
            const mockFs = mock<typeof import('vscode').workspace.fs>();

            when(mockFs.readFile(anything())).thenReturn(Promise.resolve(new TextEncoder().encode(fileContents)));
            when(mockedVSCodeNamespaces.workspace.fs).thenReturn(instance(mockFs));

            return mockFs;
        }

        function serializeProjectFile(projectId: string): string {
            const file: DeepnoteFile = {
                metadata: {
                    createdAt: '2023-01-01T00:00:00Z',
                    modifiedAt: '2023-01-02T00:00:00Z'
                },
                project: {
                    id: projectId,
                    name: 'Project',
                    notebooks: [{ id: 'notebook-1', name: 'Notebook One', blocks: [] }],
                    settings: {}
                },
                version: '1.0.0'
            };

            return serializeDeepnoteFile(file);
        }

        test('injects all four integration env vars (preserving pre-seeded SQL_* keys) when the endpoint is listening and the file has a project id', async () => {
            const mockFs = stubReadFile(serializeProjectFile('the-project-id'));
            const starter = createStarterWithEndpoint(baseUrl);

            const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };
            await applyIntegrationEndpointEnv(starter, extraEnv, projectFileUri);

            assert.deepStrictEqual(extraEnv, {
                [sqlEnvKey]: sqlEnvValue,
                DEEPNOTE_RUNTIME__ENV_INTEGRATION_ENABLED: 'true',
                DEEPNOTE_RUNTIME__RUNNING_IN_DETACHED_MODE: 'true',
                DEEPNOTE_RUNTIME__WEBAPP_URL: baseUrl,
                DEEPNOTE_PROJECT_ID: 'the-project-id'
            });
            // The enabled path must resolve the project id from the file.
            verify(mockFs.readFile(anything())).once();
        });

        test('injects nothing and does NOT read the file when the endpoint has no baseUrl', async () => {
            const mockFs = stubReadFile(serializeProjectFile('the-project-id'));
            const starter = createStarterWithEndpoint(undefined);

            const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };
            await applyIntegrationEndpointEnv(starter, extraEnv, projectFileUri);

            assert.deepStrictEqual(extraEnv, { [sqlEnvKey]: sqlEnvValue });
            // A missing baseUrl short-circuits BEFORE resolving the project id — no file read.
            verify(mockFs.readFile(anything())).never();
        });

        test('injects nothing and does NOT read the file when no endpoint was injected at all', async () => {
            // The outer-suite `serverStarter` is constructed WITHOUT the optional endpoint arg.
            const mockFs = stubReadFile(serializeProjectFile('the-project-id'));

            const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };
            await applyIntegrationEndpointEnv(serverStarter, extraEnv, projectFileUri);

            assert.deepStrictEqual(extraEnv, { [sqlEnvKey]: sqlEnvValue });
            verify(mockFs.readFile(anything())).never();
        });

        test('injects nothing when the endpoint is listening but the file resolves to no project id', async () => {
            // A schema-valid `.deepnote` whose project.id is empty — `resolveProjectIdForFile` yields a falsy id.
            stubReadFile(serializeProjectFile(''));
            const starter = createStarterWithEndpoint(baseUrl);

            const extraEnv: Record<string, string> = { [sqlEnvKey]: sqlEnvValue };
            await applyIntegrationEndpointEnv(starter, extraEnv, projectFileUri);

            assert.deepStrictEqual(extraEnv, { [sqlEnvKey]: sqlEnvValue });
        });
    });
});
