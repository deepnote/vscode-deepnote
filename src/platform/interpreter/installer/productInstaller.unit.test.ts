// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { expect } from 'chai';
import * as TypeMoq from 'typemoq';
import { CancellationTokenSource, Uri } from 'vscode';
import { InterpreterUri, IOutputChannel } from '../../../platform/common/types';
import { IServiceContainer } from '../../../platform/ioc/types';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { DataScienceInstaller } from '../../../platform/interpreter/installer/productInstaller.node';
import {
    Product,
    IInstallationChannelManager,
    InstallerResponse,
    IModuleInstaller,
    ModuleInstallerType
} from '../../../platform/interpreter/installer/types';
import { sleep } from '../../../test/core';
import { Environment } from '@vscode/python-extension';
import { anything, when } from 'ts-mockito';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

class AlwaysInstalledDataScienceInstaller extends DataScienceInstaller {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, class-methods-use-this
    public override async isInstalled(_product: Product, _resource?: InterpreterUri | Environment): Promise<boolean> {
        return true;
    }
}

/** Everything is installed except pip itself — a uv-created venv or a bare system python. */
class PipMissingDataScienceInstaller extends DataScienceInstaller {
    // eslint-disable-next-line class-methods-use-this
    public override async isInstalled(product: Product, _resource?: InterpreterUri | Environment): Promise<boolean> {
        return product !== Product.pip;
    }
}

suite('DataScienceInstaller install', async () => {
    let serviceContainer: TypeMoq.IMock<IServiceContainer>;
    let installationChannelManager: TypeMoq.IMock<IInstallationChannelManager>;
    let dataScienceInstaller: DataScienceInstaller;
    let outputChannel: TypeMoq.IMock<IOutputChannel>;
    let tokenSource: CancellationTokenSource;

    const interpreterPath = Uri.file('path/to/interpreter');

    setup(() => {
        resetVSCodeMocks();
        tokenSource = new CancellationTokenSource();
        serviceContainer = TypeMoq.Mock.ofType<IServiceContainer>();
        installationChannelManager = TypeMoq.Mock.ofType<IInstallationChannelManager>();
        outputChannel = TypeMoq.Mock.ofType<IOutputChannel>();
        when(mockedVSCodeNamespaces.window.showErrorMessage(anything())).thenResolve();
        serviceContainer
            .setup((c) => c.get(TypeMoq.It.isValue(IInstallationChannelManager)))
            .returns(() => installationChannelManager.object);

        dataScienceInstaller = new AlwaysInstalledDataScienceInstaller(serviceContainer.object, outputChannel.object);
    });

    teardown(() => {
        resetVSCodeMocks();
        tokenSource.dispose();
    });

    test('Will ignore with no installer modules', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isAny()))
            .returns(() => Promise.resolve([]));
        const result = await dataScienceInstaller.install(Product.ipykernel, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Ignore, 'Should be InstallerResponse.Ignore');
    });

    test('Will cancel when signaled', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const testInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        testInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Conda);
        testInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.ipykernel),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());

        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isAny()))
            .returns(() => sleep(5000).then(() => [testInstaller.object]));
        const resultPromise = dataScienceInstaller.install(Product.ipykernel, testEnvironment, tokenSource);
        tokenSource.cancel();
        const result = await resultPromise;
        expect(result).to.equal(InstallerResponse.Ignore, 'Should be InstallerResponse.Ignore');
    });

    test('Will invoke conda for conda environments', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const testInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        testInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Conda);
        testInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.ipykernel),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());

        installationChannelManager
            .setup((c) => c.getInstallationChannel(TypeMoq.It.isAny(), TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve(testInstaller.object));
        testInstaller.setup((p) => (p as any).then).returns(() => undefined);

        const result = await dataScienceInstaller.install(Product.ipykernel, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed');
    });

    test('Will invoke pip by default', async () => {
        const testEnvironment: PythonEnvironment = {
            uri: interpreterPath,
            id: interpreterPath.fsPath
        };
        const testInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();

        testInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Pip);
        testInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.ipykernel),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());

        installationChannelManager
            .setup((c) => c.getInstallationChannel(TypeMoq.It.isAny(), TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve(testInstaller.object));
        testInstaller.setup((p) => (p as any).then).returns(() => undefined);

        const result = await dataScienceInstaller.install(Product.ipykernel, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed');
    });

    test('Will invoke poetry', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const testInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();

        testInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Poetry);
        testInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.ipykernel),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());

        installationChannelManager
            .setup((c) => c.getInstallationChannel(TypeMoq.It.isAny(), TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve(testInstaller.object));
        testInstaller.setup((p) => (p as any).then).returns(() => undefined);

        const result = await dataScienceInstaller.install(Product.ipykernel, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed');
    });

    test('Will invoke pipenv', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const testInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();

        testInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Pipenv);
        testInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.ipykernel),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());

        installationChannelManager
            .setup((c) => c.getInstallationChannel(TypeMoq.It.isAny(), TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve(testInstaller.object));
        testInstaller.setup((p) => (p as any).then).returns(() => undefined);

        const result = await dataScienceInstaller.install(Product.ipykernel, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed');
    });

    test('Will use pip for deepnoteToolkit even on Conda interpreter (redirects away from the Conda channel)', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };

        // The channel a Conda interpreter resolves to when conda itself is discoverable.
        const condaInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        condaInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Conda);
        condaInstaller.setup((p) => (p as any).then).returns(() => undefined);
        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve([condaInstaller.object]));

        // Create a pip installer mock
        const pipInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        pipInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Pip);
        pipInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());
        pipInstaller.setup((p) => (p as any).then).returns(() => undefined);

        // serviceContainer.getAll returns both installers — the redirect must pick pip
        serviceContainer
            .setup((c) => c.getAll(TypeMoq.It.isValue(IModuleInstaller)))
            .returns(() => [condaInstaller.object, pipInstaller.object]);

        const result = await dataScienceInstaller.install(Product.deepnoteToolkit, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed via pip');

        // Verify pip was called, not conda
        pipInstaller.verify(
            (c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                ),
            TypeMoq.Times.once()
        );
        condaInstaller.verify(
            (c) =>
                c.installModule(
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                ),
            TypeMoq.Times.never()
        );
    });

    test('Will not run pip for deepnoteToolkit when the interpreter has no pip, and says so', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const condaInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        condaInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Conda);
        condaInstaller.setup((p) => (p as any).then).returns(() => undefined);
        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve([condaInstaller.object]));

        const installer = new PipMissingDataScienceInstaller(serviceContainer.object, outputChannel.object);
        const result = await installer.install(Product.deepnoteToolkit, testEnvironment, tokenSource);

        expect(result).to.equal(InstallerResponse.Ignore, 'Should not report an install it never ran');
        condaInstaller.verify(
            (c) =>
                c.installModule(
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                ),
            TypeMoq.Times.never()
        );
        installationChannelManager.verify(
            (c) => c.showNoInstallersMessage(TypeMoq.It.isValue(testEnvironment)),
            TypeMoq.Times.once()
        );
    });

    test('Will fall back to pip for deepnoteToolkit when no channel resolves but pip is present (conda/poetry env whose own tool is unreachable)', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const pipInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        pipInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Pip);
        pipInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());
        pipInstaller.setup((p) => (p as any).then).returns(() => undefined);
        serviceContainer
            .setup((c) => c.getAll(TypeMoq.It.isValue(IModuleInstaller)))
            .returns(() => [pipInstaller.object]);
        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve([]));

        const result = await dataScienceInstaller.install(Product.deepnoteToolkit, testEnvironment, tokenSource);

        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed via pip');
        pipInstaller.verify(
            (c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                ),
            TypeMoq.Times.once()
        );
        installationChannelManager.verify((c) => c.showNoInstallersMessage(TypeMoq.It.isAny()), TypeMoq.Times.never());
    });

    test('Will use uv for deepnoteToolkit when the channel is UV and the interpreter has no pip (regression: uv venvs have no pip)', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const uvInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        uvInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.UV);
        uvInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());
        uvInstaller.setup((p) => (p as any).then).returns(() => undefined);
        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve([uvInstaller.object]));

        const installer = new PipMissingDataScienceInstaller(serviceContainer.object, outputChannel.object);
        const result = await installer.install(Product.deepnoteToolkit, testEnvironment, tokenSource);

        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed via uv');
        uvInstaller.verify(
            (c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                ),
            TypeMoq.Times.once()
        );
        installationChannelManager.verify((c) => c.showNoInstallersMessage(TypeMoq.It.isAny()), TypeMoq.Times.never());
    });

    test('Will use poetry as-is for deepnoteToolkit (not redirected to pip)', async () => {
        const testEnvironment: PythonEnvironment = {
            id: interpreterPath.fsPath,
            uri: interpreterPath
        };
        const poetryInstaller = TypeMoq.Mock.ofType<IModuleInstaller>();
        poetryInstaller.setup((c) => c.type).returns(() => ModuleInstallerType.Poetry);
        poetryInstaller
            .setup((c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                )
            )
            .returns(() => Promise.resolve());
        poetryInstaller.setup((p) => (p as any).then).returns(() => undefined);
        installationChannelManager
            .setup((c) => c.getInstallationChannels(TypeMoq.It.isValue(testEnvironment)))
            .returns(() => Promise.resolve([poetryInstaller.object]));

        const result = await dataScienceInstaller.install(Product.deepnoteToolkit, testEnvironment, tokenSource);
        expect(result).to.equal(InstallerResponse.Installed, 'Should be Installed via poetry');

        poetryInstaller.verify(
            (c) =>
                c.installModule(
                    TypeMoq.It.isValue(Product.deepnoteToolkit),
                    TypeMoq.It.isValue(testEnvironment),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny(),
                    TypeMoq.It.isAny()
                ),
            TypeMoq.Times.once()
        );
    });
});
