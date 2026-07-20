import { assert } from 'chai';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Disposable, EventEmitter, NotebookDocument, Uri } from 'vscode';

import { IKernel, IKernelProvider, INotebookKernelExecution } from '../../../kernels/types';
import { IDisposable } from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { logger } from '../../../platform/logging';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { IntegrationEnvLiveRefresher } from './integrationEnvLiveRefresher.node';
import { recordStartupIntegrationEnvNames } from './startupIntegrationEnvTracker';

const ENV_VAR_NAME = 'SQL_DEMO';
const ENV_VAR_VALUE = 'postgres://demo';

const EXPECTED_NOTIFICATION = 'Deepnote integration environment updated.';

/** Every level the refresher could conceivably log through, so leak assertions cover all of them. */
const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace', 'ci'] as const;

suite('IntegrationEnvLiveRefresher', () => {
    let refresher: IntegrationEnvLiveRefresher;
    let kernelProvider: IKernelProvider;
    let envVarsProvider: ISqlIntegrationEnvVarsProvider;
    let executeHiddenSilentSpy: sinon.SinonStub;
    let onDidStartKernel: EventEmitter<IKernel>;
    let onDidRestartKernel: EventEmitter<IKernel>;
    let disposables: IDisposable[];

    setup(() => {
        resetVSCodeMocks();
        disposables = [new Disposable(() => resetVSCodeMocks())];
        kernelProvider = mock<IKernelProvider>();
        envVarsProvider = mock<ISqlIntegrationEnvVarsProvider>();

        onDidStartKernel = new EventEmitter<IKernel>();
        onDidRestartKernel = new EventEmitter<IKernel>();
        disposables.push(onDidStartKernel, onDidRestartKernel);
        when(kernelProvider.onDidStartKernel).thenReturn(onDidStartKernel.event);
        when(kernelProvider.onDidRestartKernel).thenReturn(onDidRestartKernel.event);

        when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ [ENV_VAR_NAME]: ENV_VAR_VALUE });

        executeHiddenSilentSpy = sinon.stub().resolves([]);
        when(kernelProvider.getKernelExecution(anything())).thenReturn({
            executeHiddenSilent: executeHiddenSilentSpy
        } as unknown as INotebookKernelExecution);

        refresher = new IntegrationEnvLiveRefresher(instance(kernelProvider), instance(envVarsProvider), []);
    });

    teardown(() => {
        sinon.restore();
        disposables = dispose(disposables);
    });

    /** A notebook whose kernel is started; `kernelProvider.get(notebook)` returns the returned kernel. */
    function createRunningKernel(uri: Uri): { notebook: NotebookDocument; kernel: IKernel } {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(uri);
        const notebook = instance(notebookMock);

        const kernelMock = mock<IKernel>();
        when(kernelMock.startedAtLeastOnce).thenReturn(true);
        const kernel = instance(kernelMock);
        when(kernelProvider.get(notebook)).thenReturn(kernel);

        return { notebook, kernel };
    }

    function createRunningNotebook(uri: Uri): NotebookDocument {
        return createRunningKernel(uri).notebook;
    }

    /** The code passed to the nth (0-based) `executeHiddenSilent` call. */
    function executedCode(callIndex: number): string {
        assert.isAbove(
            executeHiddenSilentSpy.callCount,
            callIndex,
            `expected at least ${callIndex + 1} execution(s), saw ${executeHiddenSilentSpy.callCount}`
        );

        return executeHiddenSilentSpy.getCall(callIndex).args[0] as string;
    }

    function stubAllLogLevels(): sinon.SinonStub[] {
        return LOG_LEVELS.map((level) => sinon.stub(logger, level));
    }

    /** Everything passed to any stubbed logger method, flattened to one searchable string. */
    function loggedText(stubs: sinon.SinonStub[]): string {
        return stubs
            .flatMap((stub) => stub.getCalls())
            .flatMap((call) => call.args)
            .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)))
            .join('\n');
    }

    test('applies the resolved env in a started kernel and shows one status-bar message', async () => {
        const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

        await refresher.refresh([notebook]);

        assert.strictEqual(executeHiddenSilentSpy.callCount, 1, 'the env snippet should run once');
        const code = executedCode(0);
        assert.include(code, `.set_env("${ENV_VAR_NAME}", "${ENV_VAR_VALUE}")`);
        assert.notInclude(code, 'set_integration_env', 'the toolkit round-trip must no longer be used');

        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
        const [message] = capture(mockedVSCodeNamespaces.window.setStatusBarMessage).last();
        assert.strictEqual(message, EXPECTED_NOTIFICATION);
    });

    test('skips notebooks with no kernel and shows no status-bar message', async () => {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(Uri.file('/ws/a.deepnote'));
        const notebook = instance(notebookMock);
        when(kernelProvider.get(notebook)).thenReturn(undefined);

        await refresher.refresh([notebook]);

        assert.strictEqual(executeHiddenSilentSpy.callCount, 0, 'no kernel means nothing to refresh');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('skips kernels that have not started and shows no status-bar message', async () => {
        const notebookMock = mock<NotebookDocument>();
        when(notebookMock.uri).thenReturn(Uri.file('/ws/a.deepnote'));
        const notebook = instance(notebookMock);

        const kernelMock = mock<IKernel>();
        when(kernelMock.startedAtLeastOnce).thenReturn(false);
        when(kernelProvider.get(notebook)).thenReturn(instance(kernelMock));

        await refresher.refresh([notebook]);

        assert.strictEqual(
            executeHiddenSilentSpy.callCount,
            0,
            'a kernel that has not started must not be executed against'
        );
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('does not show a status-bar message when the env snippet produces an error output', async () => {
        const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        executeHiddenSilentSpy.resolves([{ output_type: 'error', ename: 'error', evalue: '', traceback: [] }]);

        await refresher.refresh([notebook]);

        assert.strictEqual(
            executeHiddenSilentSpy.callCount,
            1,
            'the snippet still runs, but its output signals failure'
        );
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
    });

    test('shows exactly one status-bar message when multiple kernels are refreshed', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));

        await refresher.refresh([notebookA, notebookB]);

        assert.strictEqual(executeHiddenSilentSpy.callCount, 2, 'both started kernels are refreshed');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });

    test('continues to the next notebook when one execution throws, and still notifies for the success', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));
        executeHiddenSilentSpy.onFirstCall().rejects(new Error('kernel exploded'));
        executeHiddenSilentSpy.onSecondCall().resolves([]);

        await refresher.refresh([notebookA, notebookB]);

        assert.strictEqual(executeHiddenSilentSpy.callCount, 2, 'a throw on the first must not stop the second');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });

    test('refreshes kernels in parallel: both executions start before either resolves', async () => {
        const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));
        const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));

        // First execution resolves only once the second has been invoked; a sequential loop would deadlock (and time out).
        let markSecondInvoked!: () => void;
        const secondInvoked = new Promise<void>((resolve) => (markSecondInvoked = resolve));
        executeHiddenSilentSpy.onFirstCall().callsFake(() => secondInvoked.then(() => []));
        executeHiddenSilentSpy.onSecondCall().callsFake(() => {
            markSecondInvoked();

            return Promise.resolve([]);
        });

        await refresher.refresh([notebookA, notebookB]);

        assert.strictEqual(executeHiddenSilentSpy.callCount, 2, 'both started kernels are refreshed');
        verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
    });

    suite('removal tracking', () => {
        test('emits unset_env for a variable that disappeared since the previous refresh', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1', SQL_B: '2' });
            await refresher.refresh([notebook]);

            assert.notInclude(executedCode(0), '.unset_env(', 'nothing is tracked yet on the first refresh');

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1' });
            await refresher.refresh([notebook]);

            const code = executedCode(1);
            assert.include(code, '.unset_env("SQL_B")', 'the removed variable must be unset in the kernel');
            assert.include(code, '.set_env("SQL_A", "1")');
            assert.notInclude(code, '.unset_env("SQL_A")');
        });

        test('keeps tracking an already-set variable when a later push fails, so the removal is retried', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1', SQL_B: '2' });
            await refresher.refresh([notebook]);

            // SQL_B disappears, but the push fails — the kernel still holds both.
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1' });
            executeHiddenSilentSpy
                .onSecondCall()
                .resolves([{ output_type: 'error', ename: 'error', evalue: '', traceback: [] }]);
            await refresher.refresh([notebook]);

            await refresher.refresh([notebook]);

            assert.include(
                executedCode(2),
                '.unset_env("SQL_B")',
                'a failed push must not make the refresher forget that SQL_B is still set'
            );
        });

        test('tracks the variables a partially-applied snippet may already have set', async () => {
            // `stop_on_error: false` governs subsequent queued requests, not the statements within one
            // request: an exception part-way through leaves every earlier line applied. So on failure
            // the names the snippet tried to set have to stay tracked — otherwise a variable that did
            // land in the kernel is invisible to the refresher and a later deletion never removes it.
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1' });
            await refresher.refresh([notebook]);

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({
                SQL_A: '1',
                SQL_B: '2',
                SQL_C: '3'
            });
            executeHiddenSilentSpy
                .onSecondCall()
                .resolves([{ output_type: 'error', ename: 'error', evalue: '', traceback: [] }]);
            await refresher.refresh([notebook]);

            // Both integrations are deleted again; whatever the failed snippet managed to apply must go.
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1' });
            await refresher.refresh([notebook]);

            const code = executedCode(2);
            assert.include(code, '.unset_env("SQL_B")', 'SQL_B may have been applied before the error');
            assert.include(code, '.unset_env("SQL_C")', 'SQL_C may have been applied before the error');
        });

        test('tracks each kernel separately', async () => {
            const notebookA = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_A: '1' });
            await refresher.refresh([notebookA]);

            const notebookB = createRunningNotebook(Uri.file('/ws/b.deepnote'));
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_B: '2' });
            await refresher.refresh([notebookB]);

            assert.notInclude(
                executedCode(1),
                '.unset_env(',
                "a fresh kernel must not inherit another kernel's baseline"
            );
        });
    });

    suite('per-kernel serialization', () => {
        test('does not interleave two overlapping refreshes of the same kernel', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));
            const events: string[] = [];

            let releaseFirst!: () => void;
            const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
            executeHiddenSilentSpy.onFirstCall().callsFake(() => {
                events.push('start-1');

                return firstReleased.then(() => {
                    events.push('end-1');

                    return [];
                });
            });
            executeHiddenSilentSpy.onSecondCall().callsFake(() => {
                events.push('start-2');

                return Promise.resolve().then(() => {
                    events.push('end-2');

                    return [];
                });
            });

            const first = refresher.refresh([notebook]);
            // Let the first refresh reach the kernel before the second is requested, so the second
            // queues behind an in-flight execution rather than superseding it.
            await new Promise((resolve) => setTimeout(resolve, 0));
            const second = refresher.refresh([notebook]);
            releaseFirst();
            await Promise.all([first, second]);

            assert.deepStrictEqual(
                events,
                ['start-1', 'end-1', 'start-2', 'end-2'],
                'the second execution must not start until the first has finished'
            );
        });

        test('drops a queued refresh once a newer one supersedes it, so a stale read cannot land last', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            // Both refreshes are requested before either reads configuration; only the newer one
            // should reach the kernel, since it is the one that reads the fresher configuration.
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ [ENV_VAR_NAME]: 'newest' });

            await Promise.all([refresher.refresh([notebook]), refresher.refresh([notebook])]);

            assert.strictEqual(executeHiddenSilentSpy.callCount, 1, 'the superseded refresh must not execute');
            assert.include(executedCode(0), `.set_env("${ENV_VAR_NAME}", "newest")`);
            verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();
        });
    });

    suite('empty-result guard', () => {
        test('keeps the current environment when the provider resolves nothing but variables are set', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));
            const warnStub = sinon.stub(logger, 'warn');

            await refresher.refresh([notebook]);
            assert.strictEqual(executeHiddenSilentSpy.callCount, 1, 'the first refresh establishes the baseline');

            // getEnvironmentVariables resolves to {} on its soft-failure paths, and a healthy Deepnote
            // notebook always yields at least the internal DuckDB variable — so this is a failed read,
            // and applying it would unset every tracked name.
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({});
            await refresher.refresh([notebook]);

            assert.strictEqual(executeHiddenSilentSpy.callCount, 1, 'an empty read must not execute anything');
            assert.strictEqual(warnStub.callCount, 1, 'the skipped refresh must be reported');
            assert.include(warnStub.firstCall.args[0], 'keeping the current environment');
            assert.notInclude(warnStub.firstCall.args[0], ENV_VAR_VALUE, 'the warning must carry no credential');
            verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).once();

            // The baseline survived: a later good read still knows the variable is set in the kernel.
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_OTHER: 'x' });
            await refresher.refresh([notebook]);

            assert.include(
                executedCode(1),
                `.unset_env("${ENV_VAR_NAME}")`,
                'the baseline must have been preserved across the empty read'
            );
        });

        test('reports no update when the provider resolves nothing and nothing is tracked yet', async () => {
            // The M4 guard above only covers a non-empty baseline. With an empty one the snippet comes
            // out empty, and executing an empty snippet and reporting success would announce an
            // environment update to the user that never happened — while the empty read is, as above,
            // far more likely to be one of `getEnvironmentVariables`' soft failures than a real
            // "no integrations configured" state.
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({});

            await refresher.refresh([notebook]);

            assert.strictEqual(executeHiddenSilentSpy.callCount, 0, 'an empty snippet must not be sent to the kernel');
            verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
        });

        test('treats an undefined provider result as an empty one', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            await refresher.refresh([notebook]);

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve(
                undefined as unknown as Record<string, string>
            );
            await refresher.refresh([notebook]);

            assert.strictEqual(executeHiddenSilentSpy.callCount, 1, 'an undefined read must not wipe the environment');
        });
    });

    suite('leak safety', () => {
        test('logs neither the credential nor the outputs when the snippet fails', async () => {
            const secret = 'postgres://user:hunter2-token@host/db';
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ [ENV_VAR_NAME]: secret });
            executeHiddenSilentSpy.resolves([
                { output_type: 'error', ename: 'UnicodeEncodeError', evalue: secret, traceback: [secret] }
            ]);
            const stubs = stubAllLogLevels();

            await refresher.refresh([notebook]);

            const logged = loggedText(stubs);
            assert.notInclude(logged, secret, 'the credential must never be logged');
            assert.notInclude(logged, 'hunter2-token');
            assert.notInclude(logged, 'set_env', 'the executed code must never be logged');
            assert.notInclude(logged, 'UnicodeEncodeError', 'the outputs object must never be logged');
            assert.notInclude(logged, 'traceback');
            assert.include(logged, 'Failed to apply the integration environment', 'the failure is still reported');
        });

        test('logs no credential when an entry cannot be applied and the refresh is aborted', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            // A lone surrogate cannot be assigned to os.environ, so the snippet builder fails closed.
            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({
                SQL_BROKEN: 'secret-\uD800-value'
            });
            const stubs = stubAllLogLevels();

            await refresher.refresh([notebook]);

            assert.strictEqual(executeHiddenSilentSpy.callCount, 0, 'nothing may be executed for an invalid entry');

            const logged = loggedText(stubs);
            assert.notInclude(logged, 'secret-', 'the rejected value must never be logged');
            assert.notInclude(logged, 'SQL_BROKEN', 'not even the variable name may be logged');
            assert.include(logged, 'Refresh aborted');
            verify(mockedVSCodeNamespaces.window.setStatusBarMessage(anything(), anything())).never();
        });

        test('logs no credential when the provider itself rejects', async () => {
            const notebook = createRunningNotebook(Uri.file('/ws/a.deepnote'));

            when(envVarsProvider.getEnvironmentVariables(anything())).thenReject(new Error('config unreadable'));
            const stubs = stubAllLogLevels();

            await refresher.refresh([notebook]);

            assert.strictEqual(executeHiddenSilentSpy.callCount, 0);
            assert.notInclude(loggedText(stubs), ENV_VAR_VALUE);
        });
    });

    suite('removal baseline seeding', () => {
        test('uses the startup names even when the start event has not been delivered yet', async () => {
            // `kernel.ts` latches `_startedAtLeastOnce` — the only gate on a refresh — well before it
            // fires `_onStarted`, which is what drives seeding. A refresh landing in that window would
            // otherwise read an empty baseline and silently skip the removal of a just-deleted
            // credential, so the startup names have to be consulted when the baseline is read, not
            // only when the event arrives.
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));
            recordStartupIntegrationEnvNames(kernel, ['SQL_FROM_STARTUP']);

            refresher.activate();
            // Deliberately no onDidStartKernel.fire(kernel): this is the pre-event window.

            await refresher.refresh([notebook]);

            assert.include(
                executedCode(0),
                '.unset_env("SQL_FROM_STARTUP")',
                'a credential deleted between kernel start and the start event must still be removed'
            );
        });

        test('seeds the baseline when a kernel starts', async () => {
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));
            recordStartupIntegrationEnvNames(kernel, ['SQL_FROM_STARTUP']);

            refresher.activate();
            onDidStartKernel.fire(kernel);

            await refresher.refresh([notebook]);

            assert.include(
                executedCode(0),
                '.unset_env("SQL_FROM_STARTUP")',
                'the startup provider wrote this variable, so the refresher must be able to remove it'
            );
        });

        test('seeds the baseline when a kernel restarts', async () => {
            // A restart fires onDidRestartKernel, not onDidStartKernel, and re-runs the startup code.
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));
            recordStartupIntegrationEnvNames(kernel, ['SQL_FROM_RESTART']);

            refresher.activate();
            onDidRestartKernel.fire(kernel);

            await refresher.refresh([notebook]);

            assert.include(executedCode(0), '.unset_env("SQL_FROM_RESTART")');
        });

        test('unions the startup names into the baseline rather than replacing it', async () => {
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));

            // A live refresh has already set SQL_DEMO in this kernel.
            await refresher.refresh([notebook]);

            recordStartupIntegrationEnvNames(kernel, ['SQL_FROM_STARTUP']);
            refresher.activate();
            onDidStartKernel.fire(kernel);

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_NEW: 'v' });
            await refresher.refresh([notebook]);

            const code = executedCode(1);
            assert.include(code, '.unset_env("SQL_FROM_STARTUP")', 'the seeded name must be tracked');
            assert.include(code, `.unset_env("${ENV_VAR_NAME}")`, 'seeding must not discard what was already tracked');
        });

        test('keeps a name the startup provider wrote even after the configuration changed', async () => {
            // The whole point of recording what the startup provider emitted: an edit landing between
            // its read and any later re-read would drop SQL_EDITED, and it would then never be removed.
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));
            recordStartupIntegrationEnvNames(kernel, ['SQL_EDITED']);

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ [ENV_VAR_NAME]: ENV_VAR_VALUE });

            refresher.activate();
            onDidStartKernel.fire(kernel);

            await refresher.refresh([notebook]);

            assert.include(
                executedCode(0),
                '.unset_env("SQL_EDITED")',
                'a variable written at startup must stay removable even though the current config omits it'
            );
        });

        test('tracks nothing when the startup provider recorded no names for the kernel', async () => {
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));

            refresher.activate();
            onDidStartKernel.fire(kernel);

            await refresher.refresh([notebook]);

            assert.notInclude(executedCode(0), '.unset_env(');
        });

        test('does not interleave seeding with an in-flight refresh', async () => {
            const { notebook, kernel } = createRunningKernel(Uri.file('/ws/a.deepnote'));
            recordStartupIntegrationEnvNames(kernel, ['SQL_FROM_STARTUP']);
            refresher.activate();

            let releaseFirst!: () => void;
            const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
            executeHiddenSilentSpy.onFirstCall().callsFake(() => firstReleased.then(() => []));

            const inFlight = refresher.refresh([notebook]);
            await new Promise((resolve) => setTimeout(resolve, 0));

            // Seeds while the refresh is between reading and writing the baseline; queueing is what
            // stops the refresh's write from discarding the seeded name.
            onDidStartKernel.fire(kernel);
            releaseFirst();
            await inFlight;

            when(envVarsProvider.getEnvironmentVariables(anything())).thenResolve({ SQL_NEW: 'v' });
            await refresher.refresh([notebook]);

            const code = executedCode(1);
            assert.include(code, '.unset_env("SQL_FROM_STARTUP")', 'the seeded name must survive the refresh');
            assert.include(code, `.unset_env("${ENV_VAR_NAME}")`);
        });
    });
});
