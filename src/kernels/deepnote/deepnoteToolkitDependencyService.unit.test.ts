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
import { DeepnoteToolkitDependencyService } from './deepnoteToolkitDependencyService.node';
import { DeepnoteToolkitDependencyResponse } from './types';

suite('DeepnoteToolkitDependencyService', () => {
    const interpreter: PythonEnvironment = {
        id: '/usr/bin/python3',
        uri: Uri.file('/usr/bin/python3')
    };
    const resource = Uri.file('/workspace/project/notebook.deepnote');
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
        verify(mockedVSCodeNamespaces.commands.executeCommand('python.setInterpreter')).once();
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
});
