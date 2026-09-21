// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { CancellationTokenSource, Event, EventEmitter, Memento, Uri } from 'vscode';
import { ProductNames } from './productNames';
import {
    IInstallationChannelManager,
    IInstaller,
    IModuleInstaller,
    InstallerResponse,
    IProductPathService,
    IProductService,
    ModuleInstallFlags,
    ModuleInstallerType,
    Product,
    ProductType
} from './types';
import { logValue, debugDecorator } from '../../logging';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { logger } from '../../logging';
import { getDisplayPath } from '../../common/platform/fs-paths';
import { IProcessServiceFactory } from '../../common/process/types.node';
import {
    IConfigurationService,
    IPersistentStateFactory,
    GLOBAL_MEMENTO,
    IMemento,
    IOutputChannel,
    InterpreterUri
} from '../../common/types';
import { noop } from '../../common/utils/misc';
import { IServiceContainer } from '../../ioc/types';
import { sendTelemetryEvent, Telemetry } from '../../../telemetry';
import { InterpreterPackages } from '../interpreterPackages.node';
import { getInterpreterHash } from '../../pythonEnvironments/info/interpreter';
import { STANDARD_OUTPUT_CHANNEL } from '../../common/constants';
import { raceTimeout } from '../../common/utils/async';
import { trackPackageInstalledIntoInterpreter } from './productInstaller';
import { translateProductToModule } from './utils';
import { IInterpreterPackages } from '../types';
import { IPythonExecutionFactory } from '../types.node';
import { Environment } from '@vscode/python-extension';
import { WrappedError } from '../../errors/types';

export async function isModulePresentInEnvironment(memento: Memento, product: Product, interpreter: PythonEnvironment) {
    const key = `${await getInterpreterHash(interpreter)}#${ProductNames.get(product)}`;
    if (memento.get(key, false)) {
        return true;
    }
    const packageName = translateProductToModule(product);
    const packageVersionPromise = InterpreterPackages.instance
        ? InterpreterPackages.instance
              .getPackageVersion(interpreter, packageName)
              .then((version) => (typeof version === 'string' ? 'found' : 'notfound'))
              .catch((ex) => {
                  logger.error('Failed to get interpreter package version', ex);
                  return undefined;
              })
        : Promise.resolve(undefined);
    try {
        // Dont wait for too long we don't want to delay installation prompt.
        const version = await raceTimeout(500, packageVersionPromise);
        if (typeof version === 'string') {
            return version === 'found';
        }
    } catch (ex) {
        logger.error(`Failed to check if package exists ${ProductNames.get(product)}`);
    }
}

/**
 * Writes into the directory uv installs to, rather than asking `os.access`, which consults only the
 * read-only attribute on Windows and so misses an ACL denial — the usual way a per-machine install
 * becomes unwritable. Deliberately unguarded: the traceback is the signal, so the reason reaches the
 * log with its real errno instead of being flattened into a word.
 */
const SITE_PACKAGES_WRITABLE_PROBE = `\
import sysconfig, tempfile
with tempfile.NamedTemporaryFile(dir=sysconfig.get_path("purelib")):
    pass
`;

/**
 * Installer for this extension. Finds the installer for a module and then runs it.
 */
export class DataScienceInstaller {
    protected readonly configService: IConfigurationService;

    private readonly productService: IProductService;

    protected readonly persistentStateFactory: IPersistentStateFactory;

    constructor(
        protected serviceContainer: IServiceContainer,
        _outputChannel: IOutputChannel
    ) {
        this.configService = serviceContainer.get<IConfigurationService>(IConfigurationService);
        this.productService = serviceContainer.get<IProductService>(IProductService);
        this.persistentStateFactory = serviceContainer.get<IPersistentStateFactory>(IPersistentStateFactory);
    }

    public async install(
        product: Product,
        interpreter: PythonEnvironment,
        cancelTokenSource: CancellationTokenSource,
        reInstallAndUpdate?: boolean,
        installPipIfRequired?: boolean,
        silent?: boolean
    ): Promise<InstallerResponse> {
        const channels = this.serviceContainer.get<IInstallationChannelManager>(IInstallationChannelManager);
        let installer: IModuleInstaller | undefined;

        if (product === Product.deepnoteToolkit) {
            const allInstallers = this.serviceContainer.getAll<IModuleInstaller>(IModuleInstaller);
            const supported = await channels.getInstallationChannels(interpreter);
            // poetry and pipenv record what they install in the project's manifest and lockfile, so
            // installing behind their back leaves the toolkit in an environment their own
            // `install --sync` would strip. They keep precedence over the faster uv.
            const native = supported.find(
                (i) => i.type === ModuleInstallerType.Poetry || i.type === ModuleInstallerType.Pipenv
            );
            // deepnote-toolkit[server] resolves to ~200 wheels (~950 MB). The channel manager only
            // offers uv when nothing else applies, but uv installs that set in a fraction of pip's
            // time, so take it whenever the `uv` binary is available and it can write to the target.
            const uvInstaller = allInstallers.find((i) => i.type === ModuleInstallerType.UV);

            if (native) {
                installer = native;
            } else if (
                uvInstaller &&
                // isSupported memoises one `uv --version`; the probe spawns python, so ask it second.
                (await uvInstaller.isSupported(interpreter)) &&
                (await this.canUvWriteToSitePackages(interpreter))
            ) {
                installer = uvInstaller;
            } else {
                // deepnote-toolkit is PyPI-only and conda's `pkg[extra]` brackets mean build constraints,
                // not extras, so conda can never install it. pip is the last resort for a conda/poetry/
                // pipenv env whose own tool is unreachable — PipInstaller excludes itself from those types.
                installer = supported.find((i) => i.type !== ModuleInstallerType.Conda);
                if (!installer && (await this.isInstalled(Product.pip, interpreter))) {
                    installer = allInstallers.find((i) => i.type === ModuleInstallerType.Pip);
                }
            }
            if (!installer) {
                channels.showNoInstallersMessage(interpreter);
            }
        } else {
            installer = await channels.getInstallationChannel(product, interpreter);
        }

        if (!installer) {
            return InstallerResponse.Ignore;
        }
        if (cancelTokenSource.token.isCancellationRequested) {
            return InstallerResponse.Cancelled;
        }
        let flags =
            reInstallAndUpdate === true
                ? ModuleInstallFlags.updateDependencies | ModuleInstallFlags.reInstall
                : undefined;
        if (installPipIfRequired === true) {
            flags = flags ? flags | ModuleInstallFlags.installPipIfRequired : ModuleInstallFlags.installPipIfRequired;
        }
        await installer.installModule(product, interpreter, cancelTokenSource, flags, silent);
        if (cancelTokenSource.token.isCancellationRequested) {
            return InstallerResponse.Cancelled;
        }
        return this.isInstalled(product, interpreter).then((isInstalled) => {
            return isInstalled ? InstallerResponse.Installed : InstallerResponse.Ignore;
        });
    }

    @debugDecorator('Checking if product is installed')
    public async isInstalled(
        product: Product,
        @logValue('path') interpreter: PythonEnvironment | Environment
    ): Promise<boolean> {
        const executableName = this.getExecutableNameFromSettings(product, undefined);
        const isModule = this.isExecutableAModule(product, undefined);
        if (isModule) {
            const pythonProcess = await this.serviceContainer
                .get<IPythonExecutionFactory>(IPythonExecutionFactory)
                .createActivatedEnvironment({
                    resource: undefined,
                    interpreter
                });
            return pythonProcess.isModuleInstalled(executableName);
        } else {
            const process = await this.serviceContainer
                .get<IProcessServiceFactory>(IProcessServiceFactory)
                .create(undefined);
            return process
                .exec(executableName, ['--version'], { mergeStdOutErr: true })
                .then(() => true)
                .catch(() => false);
        }
    }

    /**
     * uv installs into the interpreter's own site-packages and rejects `--user` outright, so it
     * cannot serve an interpreter whose site-packages the user cannot write — a per-machine system
     * python, or a conda prefix owned by root in a container. pip can, through `--user`, and keeps
     * those environments. Probed rather than inferred from the environment type, which answers a
     * different question: a root-owned conda prefix is still typed `Conda`.
     *
     * `throwOnStdErr` turns the probe's traceback into a rejection, so a probe that cannot run at
     * all is treated the same as one that reported no access — both leave the environment on pip,
     * which is where it was before uv was preferred.
     */
    protected async canUvWriteToSitePackages(interpreter: PythonEnvironment): Promise<boolean> {
        try {
            const python = await this.serviceContainer
                .get<IPythonExecutionFactory>(IPythonExecutionFactory)
                .create({ resource: undefined, interpreter });
            await python.exec(['-c', SITE_PACKAGES_WRITABLE_PROBE], { throwOnStdErr: true });

            return true;
        } catch (ex) {
            logger.warn(`Cannot write to site-packages of ${getDisplayPath(interpreter.uri)}, leaving uv out`, ex);

            return false;
        }
    }

    protected getExecutableNameFromSettings(product: Product, resource?: Uri): string {
        const productType = this.productService.getProductType(product);
        const productPathService = this.serviceContainer.get<IProductPathService>(IProductPathService, productType);
        return productPathService.getExecutableNameFromSettings(product, resource);
    }

    protected isExecutableAModule(product: Product, resource?: Uri): boolean {
        const productType = this.productService.getProductType(product);
        const productPathService = this.serviceContainer.get<IProductPathService>(IProductPathService, productType);
        return productPathService.isExecutableAModule(product, resource);
    }
}

/**
 * Main interface to installing.
 */
@injectable()
export class ProductInstaller implements IInstaller {
    private readonly productService: IProductService;
    private readonly _onInstalled = new EventEmitter<{ product: Product; resource?: InterpreterUri }>();
    public get onInstalled(): Event<{ product: Product; resource?: InterpreterUri }> {
        return this._onInstalled.event;
    }

    constructor(
        @inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IInterpreterPackages) private readonly interpreterPackages: IInterpreterPackages,
        @inject(IMemento) @named(GLOBAL_MEMENTO) private readonly memento: Memento,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly output: IOutputChannel
    ) {
        this.productService = serviceContainer.get<IProductService>(IProductService);
    }

    public dispose(): void {
        /** Do nothing. */
    }

    public async install(
        product: Product,
        interpreter: PythonEnvironment,
        cancelTokenSource: CancellationTokenSource,
        reInstallAndUpdate?: boolean,
        installPipIfRequired?: boolean,
        silent?: boolean
    ): Promise<InstallerResponse> {
        if (interpreter) {
            this.interpreterPackages.trackPackages(interpreter);
        }
        let action: 'installed' | 'failed' | 'disabled' | 'ignored' | 'cancelled' = 'installed';
        try {
            const result = await this.createInstaller(product).install(
                product,
                interpreter,
                cancelTokenSource,
                reInstallAndUpdate,
                installPipIfRequired,
                silent
            );
            trackPackageInstalledIntoInterpreter(this.memento, product, interpreter).catch(noop);
            if (result === InstallerResponse.Installed) {
                this._onInstalled.fire({ product, resource: interpreter });
            }
            switch (result) {
                case InstallerResponse.Cancelled:
                    action = 'cancelled';
                    break;
                case InstallerResponse.Installed:
                    action = 'installed';
                    break;
                case InstallerResponse.Ignore:
                    action = 'ignored';
                    break;
                case InstallerResponse.Disabled:
                    action = 'disabled';
                    break;
                default:
                    break;
            }
            return result;
        } catch (ex) {
            action = 'failed';
            throw ex;
        } finally {
            sendTelemetryEvent(Telemetry.PythonModuleInstall, undefined, {
                action,
                moduleName: ProductNames.get(product)!
            });
        }
    }

    public async isInstalled(product: Product, interpreter: PythonEnvironment | Environment): Promise<boolean> {
        return this.createInstaller(product).isInstalled(product, interpreter);
    }

    // eslint-disable-next-line class-methods-use-this
    public translateProductToModuleName(product: Product): string {
        return translateProductToModule(product);
    }

    private createInstaller(product: Product): DataScienceInstaller {
        const productType = this.productService.getProductType(product);
        switch (productType) {
            case ProductType.DataScience:
                return new DataScienceInstaller(this.serviceContainer, this.output);
            default:
                break;
        }
        throw new WrappedError(`Unknown product ${product}`, undefined, 'unknownProduct');
    }
}
