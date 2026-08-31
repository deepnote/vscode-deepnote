import { assert } from 'chai';
import { PythonExtension } from '@vscode/python-extension';
import * as sinon from 'sinon';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { setPythonApi } from '../../platform/interpreter/helpers';
import { resolvableInstance } from '../../test/datascience/helpers';

import { IInstaller, InstallerResponse, Product } from '../../platform/interpreter/installer/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { Commands } from '../../platform/common/constants';
import { Common } from '../../platform/common/utils/localize';
import { DeepnoteToolkitDependencyService } from './deepnoteToolkitDependencyService.node';
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
    let service: DeepnoteToolkitDependencyService;

    /** Makes the consent prompt resolve to `choice` (undefined = the user dismissed it). */
    function answerPrompt(choice: string | undefined) {
        when(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).thenResolve(choice as never);
    }

    setup(() => {
        resetVSCodeMocks();
        installer = mock<IInstaller>();
        service = new DeepnoteToolkitDependencyService(instance(installer));

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
        when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(true);

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
        verify(
            mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
        ).never();
        verify(installer.install(anything(), anything(), anything())).never();
    });

    test('installs only after the user consents', async () => {
        when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
        when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Installed);
        answerPrompt('Install');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.ok);
        verify(installer.install(Product.deepnoteToolkit, anything(), anything())).once();
    });

    test('does NOT install when the user dismisses the prompt', async () => {
        when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
        answerPrompt(undefined);

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.cancel);
        verify(installer.install(anything(), anything(), anything())).never();
    });

    test('does NOT install when the user opts to change interpreter, and opens the picker', async () => {
        when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
        answerPrompt('Select a different Interpreter');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.selectDifferentInterpreter);
        verify(installer.install(anything(), anything(), anything())).never();
        verify(mockedVSCodeNamespaces.commands.executeCommand(Commands.SelectInterpreterForNotebook)).once();
    });

    test('reports a cancelled install as cancel, not failure', async () => {
        when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
        when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Cancelled);
        answerPrompt('Install');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.cancel);
    });

    test('reports an install that did not take as failed', async () => {
        when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
        when(installer.install(anything(), anything(), anything())).thenResolve(InstallerResponse.Ignore);
        answerPrompt('Install');

        const result = await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

        assert.strictEqual(result, DeepnoteToolkitDependencyResponse.failed);
    });
    suite('concurrent callers', () => {
        test('two notebooks on one interpreter get one prompt and one install', async () => {
            when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
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
            when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
            answerPrompt(undefined);

            await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);
            await service.ensureToolkitInstalled(interpreter, resource, notCancelled as never);

            verify(
                mockedVSCodeNamespaces.window.showInformationMessage(anything(), anything(), anything(), anything())
            ).twice();
        });

        test('a joined caller whose notebook closed reports cancel, without stopping the install', async () => {
            when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
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
            when(installer.isInstalled(Product.deepnoteToolkit, anything())).thenResolve(false);
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
