import { assert } from 'chai';
import { PythonExtension } from '@vscode/python-extension';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { setPythonApi } from '../../platform/interpreter/helpers';
import { resolvableInstance } from '../../test/datascience/helpers';

import { IInstaller, InstallerResponse, Product } from '../../platform/interpreter/installer/types';
import { IPythonExecutionFactory, IPythonExecutionService } from '../../platform/interpreter/types.node';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { Commands, DEEPNOTE_TOOLKIT_VERSION } from '../../platform/common/constants';
import { Common } from '../../platform/common/utils/localize';
import {
    DeepnoteToolkitDependencyService,
    ToolkitProbe,
    isOlderRelease,
    toolkitState
} from './deepnoteToolkitDependencyService.node';
import { DeepnoteToolkitDependencyResponse } from './types';

suite('DeepnoteToolkitDependencyService', () => {
    const interpreter: PythonEnvironment = {
        id: '/usr/bin/python3',
        uri: Uri.file('/usr/bin/python3')
    };
    const resource = Uri.file('/workspace/project/notebook.deepnote');
    const otherResource = Uri.file('/workspace/project/other.deepnote');
    const notCancelled = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };

    let installer: IInstaller;
    let python: IPythonExecutionService;
    let service: DeepnoteToolkitDependencyService;

    /** Makes the consent prompt resolve to `choice` (undefined = the user dismissed it). */
    function answerPrompt(choice: string | undefined) {
        when(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).thenResolve(choice as never);
    }

    /** What the metadata probe prints in the interpreter. */
    function probeReports(probe: ToolkitProbe) {
        when(python.exec(anything(), anything())).thenResolve({
            stdout: `${JSON.stringify({ version: probe.version ?? null, server: probe.server })}\n`,
            stderr: ''
        });
    }

    const missing: ToolkitProbe = { server: false };
    const current: ToolkitProbe = { version: DEEPNOTE_TOOLKIT_VERSION, server: true };

    /** Whether the one prompt shown was worded as an update rather than a first install. */
    function promptedForUpdate(): boolean {
        verify(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).once();
        const [message] = capture(mockedVSCodeNamespaces.window.showInformationMessage).last();

        return String(message).includes('requires an update');
    }

    setup(() => {
        resetVSCodeMocks();
        installer = mock<IInstaller>();
        python = mock<IPythonExecutionService>();
        const factory = mock<IPythonExecutionFactory>();
        when(factory.createActivatedEnvironment(anything())).thenResolve(resolvableInstance(python));
        service = new DeepnoteToolkitDependencyService(instance(installer), instance(factory));

        // The prompt names the environment via getPythonEnvDisplayName, which reads the Python API.
        const mockedApi = mock<PythonExtension>();
        sinon.stub(PythonExtension, 'api').resolves(resolvableInstance(mockedApi));
        const environments = mock<PythonExtension['environments']>();
        when(mockedApi.environments).thenReturn(instance(environments));
        when(environments.known).thenReturn([]);
        setPythonApi(instance(mockedApi));
    });

    teardown(() => {
        setPythonApi(undefined as never);
        sinon.restore();
    });

    test('does not prompt when the toolkit is already installed', async () => {
        probeReports(current);

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
        verify(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).never();
        verify(installer.install(anything(), anything(), anything())).never();
    });

    suite('version and [server] extra gate (#489)', () => {
        test('a toolkit older than the pin gets the update prompt, and Install brings it to the pin', async () => {
            probeReports({ version: '0.0.1', server: true });
            when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Installed);
            answerPrompt(Common.install);

            const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
            assert.isTrue(promptedForUpdate(), 'the prompt must say the toolkit needs an update');
            // The installer's pip line is `install -U deepnote-toolkit[server]==<pin>`, so the same
            // install both upgrades and pulls in the extra.
            verify(installer.install(Product.deepnoteToolkit, anything(), anything())).once();
        });

        test('a toolkit installed without [server] gets the update prompt, not a server startup failure', async () => {
            probeReports({ version: DEEPNOTE_TOOLKIT_VERSION, server: false });
            answerPrompt(undefined);

            const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            assert.strictEqual(result, DeepnoteToolkitDependencyResponse.cancel);
            assert.isTrue(promptedForUpdate(), 'the prompt must say the toolkit needs an update');
        });

        test('a missing toolkit gets the install wording, not the update one', async () => {
            probeReports(missing);
            answerPrompt(undefined);

            await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            assert.isFalse(promptedForUpdate(), 'a missing toolkit is an install, not an update');
        });

        test('a newer toolkit passes, so a developer on an unreleased build is not asked to downgrade', async () => {
            probeReports({ version: '999.0.0.dev0', server: true });

            const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
            verify(
                mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
            ).never();
        });

        test('falls back to the import check when the probe cannot run', async () => {
            when(python.exec(anything(), anything())).thenReject(new Error('spawn EACCES'));
            when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(true);

            const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
        });

        test('treats unparsable probe output as a failed probe', async () => {
            when(python.exec(anything(), anything())).thenResolve({ stdout: 'Traceback...', stderr: '' });
            when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
            answerPrompt(undefined);

            const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            assert.strictEqual(result, DeepnoteToolkitDependencyResponse.cancel);
        });

        suite('toolkitState', () => {
            test('ok only when present, at least the pin, and with the extra', () => {
                assert.strictEqual(toolkitState({ version: '2.5.1', server: true }, '2.5.1'), 'ok');
                assert.strictEqual(toolkitState({ version: '2.6.0', server: true }, '2.5.1'), 'ok');
                assert.strictEqual(toolkitState({ version: '2.5.0', server: true }, '2.5.1'), 'needsUpdate');
                assert.strictEqual(toolkitState({ version: '2.5.1', server: false }, '2.5.1'), 'needsUpdate');
                assert.strictEqual(toolkitState({ version: '2.5.1rc1', server: true }, '2.5.1'), 'needsUpdate');
                assert.strictEqual(toolkitState({ version: '2.5.1.dev0', server: true }, '2.5.1'), 'needsUpdate');
                assert.strictEqual(toolkitState({ server: false }, '2.5.1'), 'missing');
                assert.strictEqual(toolkitState({ server: true }, '2.5.1'), 'missing');
            });
        });

        suite('isOlderRelease', () => {
            test('compares release segments numerically', () => {
                assert.isTrue(isOlderRelease('2.5.1', '2.5.2'));
                assert.isTrue(isOlderRelease('2.9.9', '2.10.0'));
                assert.isTrue(isOlderRelease('2.5', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1.0', '2.5.1'));
                assert.isFalse(isOlderRelease('3.0.0', '2.5.1'));
            });

            test('orders pre-releases and dev builds of the pinned version as older than it (PEP 440)', () => {
                assert.isTrue(isOlderRelease('2.5.1rc1', '2.5.1'));
                assert.isTrue(isOlderRelease('2.5.1b2', '2.5.1'));
                assert.isTrue(isOlderRelease('2.5.1a1', '2.5.1'));
                assert.isTrue(isOlderRelease('2.5.1.dev0', '2.5.1'));
                assert.isTrue(isOlderRelease('2.5.1.dev0', '2.5.1a1'), 'a dev build precedes every pre-release');
                assert.isTrue(isOlderRelease('2.5.1a1', '2.5.1b1'));
                assert.isTrue(isOlderRelease('2.5.1b1', '2.5.1rc1'));
                assert.isTrue(isOlderRelease('2.5.1rc1', '2.5.1rc2'));
                assert.isTrue(isOlderRelease('2.5.1rc1.dev0', '2.5.1rc1'));
                assert.isTrue(isOlderRelease('2.5.0.dev0', '2.5.1'));
            });

            test('treats a dev build of a later release, and post or local releases of the pin, as current', () => {
                assert.isFalse(isOlderRelease('2.6.0.dev0', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1.post1', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1+local', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1', '2.5.1rc1'));
                assert.isFalse(isOlderRelease('2.5.1', '2.5.1.dev0'));
                assert.isTrue(isOlderRelease('2.5.1', '2.5.1.post1'));
            });

            test('accepts every PEP 440 post-release spelling and orders it after the final release', () => {
                assert.isTrue(isOlderRelease('2.5.0-r1', '2.5.1'), 'a post-release of an older version is still older');
                assert.isTrue(isOlderRelease('2.5.0.rev1', '2.5.1'));
                assert.isTrue(isOlderRelease('2.5.0-1', '2.5.1'), 'implicit post-release');
                assert.isFalse(isOlderRelease('2.5.1-r1', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1.rev1', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1-1', '2.5.1'));
                assert.isFalse(isOlderRelease('2.5.1r1', '2.5.1rc1'), '`r` is a post-release, not a release candidate');
                assert.isTrue(isOlderRelease('2.5.1', '2.5.1-1'));
                assert.isTrue(isOlderRelease('2.5.1.post', '2.5.1.post1'), 'a bare `post` is post-release 0');
                assert.isTrue(isOlderRelease('2.5.1-1', '2.5.1.post2'));
                assert.isFalse(
                    isOlderRelease('2.5.1-1', '2.5.1.post1'),
                    'spellings of the same post-release are equal'
                );
            });

            test('does not call a version it cannot read older', () => {
                assert.isFalse(isOlderRelease('editable', '2.5.1'));
                assert.isFalse(isOlderRelease('', '2.5.1'));
            });
        });
    });

    test('installs only after the user consents', async () => {
        probeReports(missing);
        when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Installed);
        answerPrompt('Install');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
        verify(installer.install(Product.deepnoteToolkit, anything(), anything())).once();
    });

    test('does NOT install when the user dismisses the prompt', async () => {
        probeReports(missing);
        answerPrompt(undefined);

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.cancel);
        verify(installer.install(anything(), anything(), anything())).never();
    });

    test('reports the interpreter change without installing or opening the picker itself', async () => {
        probeReports(missing);
        answerPrompt('Select a different Interpreter');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.selectDifferentInterpreter);
        verify(installer.install(anything(), anything(), anything())).never();
        // Driving the picker from here would re-enter this check through the switch it starts, and
        // that check is the shared promise this call is still inside — it would join itself.
        verify(mockedVSCodeNamespaces.commands.executeCommand(Commands.SelectInterpreterForNotebook)).never();
    });

    test('settles the shared entry, so a re-check for the same interpreter prompts again', async () => {
        probeReports(missing);
        answerPrompt('Select a different Interpreter');

        await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);
        const second = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(second, DeepnoteToolkitDependencyResponse.selectDifferentInterpreter);
        verify(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).twice();
    });

    test('reports a cancelled install as cancel, not failure', async () => {
        probeReports(missing);
        when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Cancelled);
        answerPrompt('Install');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.cancel);
    });

    test('reports an install that did not take as failed', async () => {
        probeReports(missing);
        when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Ignore);
        answerPrompt('Install');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.failed);
    });
    suite('concurrent callers', () => {
        test('two notebooks on one interpreter get one prompt and one install', async () => {
            probeReports(missing);
            answerPrompt(Common.install);

            let releaseInstall!: () => void;
            const installing = new Promise<void>((resolve) => (releaseInstall = resolve));
            when(installer.install(Product.deepnoteToolkit, anything(), anything())).thenCall(async () => {
                await installing;

                return InstallerResponse.Installed;
            });

            const both = Promise.all([
                service.ensureToolkitInstalled(interpreter, resource, notCancelled as never),
                service.ensureToolkitInstalled(interpreter, otherResource, notCancelled as never)
            ]);

            releaseInstall();
            const [first, second] = await both;

            assert.strictEqual(first, DeepnoteToolkitDependencyResponse.ok);
            assert.strictEqual(second, DeepnoteToolkitDependencyResponse.ok, 'the joined caller shares the outcome');
            verify(
                mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
            ).once();
            verify(installer.install(Product.deepnoteToolkit, anything(), anything())).once();
        });

        test('a later call prompts again once the first has settled', async () => {
            probeReports(missing);
            answerPrompt(undefined);

            await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);
            await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            verify(
                mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
            ).twice();
        });

        test('a joined caller whose notebook closed reports cancel, without stopping the install', async () => {
            probeReports(missing);
            answerPrompt(Common.install);
            when(installer.install(Product.deepnoteToolkit, anything(), anything())).thenResolve(
                InstallerResponse.Installed
            );
            const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => {} }) };

            const first = service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);
            const joined = service.ensureToolkitInstalled(interpreter, otherResource, cancelled as never);

            assert.strictEqual(await first, DeepnoteToolkitDependencyResponse.ok);
            assert.strictEqual(await joined, DeepnoteToolkitDependencyResponse.cancel);
            // The cancelled caller must not have started an install of its own, nor aborted the
            // one already running for the other notebook.
            verify(installer.install(Product.deepnoteToolkit, anything(), anything())).once();
        });

        test('different interpreters are not deduplicated against each other', async () => {
            probeReports(missing);
            answerPrompt(undefined);
            const other: PythonEnvironment = { id: '/envs/other/bin/python', uri: Uri.file('/envs/other/bin/python') };

            await Promise.all([
                service.ensureToolkitInstalled(interpreter, resource, notCancelled as never),
                service.ensureToolkitInstalled(other, otherResource, notCancelled as never)
            ]);

            verify(
                mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
            ).twice();
        });
    });
});
