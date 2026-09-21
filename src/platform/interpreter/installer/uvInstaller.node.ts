// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { workspace } from 'vscode';

import { IServiceContainer } from '../../ioc/types';
import { ExecutionInstallArgs, ModuleInstaller } from './moduleInstaller.node';
import { IProcessServiceFactory } from '../../common/process/types.node';
import { ModuleInstallerType, ModuleInstallFlags } from './types';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { Environment } from '@vscode/python-extension';
import { getInterpreterInfo } from '../helpers';
import { translateModuleToPackages } from './utils';

/**
 * uv has no `--proxy` flag, so VS Code's `http.proxy` can only reach it through the environment, and
 * VS Code never exports that setting into the extension host's own environment. A proxy the user
 * already set in the environment wins — uv reads those directly, and overriding it would silently
 * change a working configuration.
 */
function proxyEnvironment(): NodeJS.ProcessEnv | undefined {
    const proxy = workspace.getConfiguration('http').get('proxy', '');
    const configuredInEnvironment = [
        'HTTPS_PROXY',
        'https_proxy',
        'HTTP_PROXY',
        'http_proxy',
        'ALL_PROXY',
        'all_proxy'
    ].some((name) => process.env[name]);

    return proxy && !configuredInEnvironment ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : undefined;
}

/**
 * Installer that uses the UV to manage packages.
 */
@injectable()
export class UvInstaller extends ModuleInstaller {
    private isInstalledPromise: Promise<boolean>;
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(
        @inject(IServiceContainer) serviceContainer: IServiceContainer,
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory
    ) {
        super(serviceContainer);
    }

    public get name(): string {
        return 'UvInstaller';
    }

    public get type(): ModuleInstallerType {
        return ModuleInstallerType.UV;
    }

    public get displayName() {
        return 'UV Installer';
    }

    public get priority(): number {
        return 200;
    }

    public async isSupported(interpreter: PythonEnvironment | Environment): Promise<boolean> {
        const env = await getInterpreterInfo(interpreter);
        if (!env) {
            return false;
        }
        if (this.isInstalledPromise) {
            return this.isInstalledPromise;
        }
        this.isInstalledPromise = this.isUvInstalled();
        return this.isInstalledPromise;
    }

    protected async getExecutionArgs(
        moduleName: string,
        interpreter: PythonEnvironment | Environment,
        flags?: ModuleInstallFlags
    ): Promise<ExecutionInstallArgs> {
        const env = await getInterpreterInfo(interpreter);
        if (!env) {
            throw new Error('Unable to get interpreter information');
        }
        const args = ['pip', 'install'];
        if (flags && flags & ModuleInstallFlags.upgrade) {
            args.push('--upgrade');
        }
        args.push('--python', env.executable.uri?.fsPath || env.path, ...translateModuleToPackages(moduleName));

        return {
            exe: 'uv',
            args,
            env: proxyEnvironment()
        };
    }

    private async isUvInstalled(): Promise<boolean> {
        const processService = await this.processServiceFactory.create(undefined);
        try {
            const result = await processService.exec('uv', ['--version'], { throwOnStdErr: true, env: process.env });
            return !!result.stdout;
        } catch (error) {
            return false;
        }
    }
}
