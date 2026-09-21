// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable local-rules/dont-use-process */

import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import * as sinon from 'sinon';
import esmock from 'esmock';
import type { WorkspaceConfiguration } from 'vscode';
import { IServiceContainer } from '../../ioc/types';
import { IProcessServiceFactory, IProcessService } from '../../common/process/types.node';
import { ModuleInstallerType, ModuleInstallFlags, Product } from './types';
import { ExecutionInstallArgs } from './moduleInstaller.node';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { Environment } from '@vscode/python-extension';
import { Uri } from 'vscode';
import type { UvInstaller } from './uvInstaller.node';
import { translateProductToModule } from './utils';
import { DEEPNOTE_TOOLKIT_PACKAGES, DEEPNOTE_TOOLKIT_VERSION } from '../../common/constants';
import { mockedVSCodeNamespaces } from '../../../test/vscode-mock';

const PROXY_ENVIRONMENT_VARIABLES = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy'
];

suite('UvInstaller', () => {
    let UvInstallerClass: typeof import('./uvInstaller.node').UvInstaller;
    let TestableUvInstallerClass: any;
    let installer: UvInstaller;
    let testableInstaller: any;
    let serviceContainer: IServiceContainer;
    let processServiceFactory: IProcessServiceFactory;
    let processService: IProcessService;
    let getInterpreterInfoStub: sinon.SinonStub;
    let workspaceConfig: WorkspaceConfiguration;
    let savedProxyEnvironment: Record<string, string | undefined>;

    setup(async () => {
        serviceContainer = mock<IServiceContainer>();
        processServiceFactory = mock<IProcessServiceFactory>();
        processService = mock<IProcessService>();

        savedProxyEnvironment = Object.fromEntries(PROXY_ENVIRONMENT_VARIABLES.map((n) => [n, process.env[n]]));
        PROXY_ENVIRONMENT_VARIABLES.forEach((name) => delete process.env[name]);

        workspaceConfig = mock<WorkspaceConfiguration>();
        when(mockedVSCodeNamespaces.workspace.getConfiguration('http')).thenReturn(instance(workspaceConfig));
        when(workspaceConfig.get('proxy', '')).thenReturn('');

        // Create stub for getInterpreterInfo helper
        getInterpreterInfoStub = sinon.stub();

        // Import UvInstaller with mocked helpers
        const module = await esmock('./uvInstaller.node', {
            '../helpers': {
                getInterpreterInfo: getInterpreterInfoStub
            }
        });

        UvInstallerClass = module.UvInstaller;

        // Test class to access protected methods
        TestableUvInstallerClass = class extends UvInstallerClass {
            public async testGetExecutionArgs(
                moduleName: string,
                interpreter: PythonEnvironment | Environment,
                flags?: ModuleInstallFlags
            ): Promise<ExecutionInstallArgs> {
                return this.getExecutionArgs(moduleName, interpreter, flags);
            }
        };

        when(processServiceFactory.create(anything())).thenResolve(instance(processService));

        installer = new UvInstallerClass(instance(serviceContainer), instance(processServiceFactory));

        testableInstaller = new TestableUvInstallerClass(instance(serviceContainer), instance(processServiceFactory));

        // Ensure 'then' is undefined to prevent hanging tests
        (instance(processService) as any).then = undefined;
        (instance(processServiceFactory) as any).then = undefined;
        (instance(serviceContainer) as any).then = undefined;
    });

    teardown(() => {
        sinon.restore();
        Object.entries(savedProxyEnvironment).forEach(([name, value]) => {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        });
    });

    suite('Basic Properties', () => {
        test('Should return correct type', () => {
            assert.equal(installer.type, ModuleInstallerType.UV);
        });

        test('Should return correct priority', () => {
            assert.equal(installer.priority, 200);
        });
    });

    suite('getExecutionArgs', () => {
        const mockPythonEnvironment = {
            uri: Uri.file('/path/to/python'),
            id: 'test-env',
            path: '/path/to/python'
        } as unknown as PythonEnvironment;

        const mockExtensionEnvironment = {
            id: 'test-env',
            path: '/path/to/python'
        } as unknown as Environment;

        const mockInterpreterInfo = {
            uri: Uri.file('/path/to/python'),
            id: 'test-env',
            path: '/path/to/python',
            executable: {
                uri: Uri.file('/path/to/python'),
                bitness: '64-bit' as const,
                sysPrefix: '/path/to/prefix'
            }
        } as unknown as PythonEnvironment;

        test('Should generate correct arguments for basic install', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);

            const result = await testableInstaller.testGetExecutionArgs('jupyter', mockPythonEnvironment);

            assert.equal(result.exe, 'uv');
            assert.deepEqual(result.args, [
                'pip',
                'install',
                '--python',
                Uri.file('/path/to/python').fsPath,
                'jupyter'
            ]);
        });

        test('Should expand deepnote-toolkit into its pinned spec plus companion packages', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);
            const moduleName = translateProductToModule(Product.deepnoteToolkit);

            const result = await testableInstaller.testGetExecutionArgs(moduleName, mockPythonEnvironment);

            assert.equal(result.exe, 'uv');
            assert.deepEqual(result.args, [
                'pip',
                'install',
                '--python',
                Uri.file('/path/to/python').fsPath,
                `deepnote-toolkit[server]==${DEEPNOTE_TOOLKIT_VERSION}`,
                ...DEEPNOTE_TOOLKIT_PACKAGES
            ]);
        });

        test('Should generate correct arguments with upgrade flag', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);

            const result = await testableInstaller.testGetExecutionArgs(
                'jupyter',
                mockPythonEnvironment,
                ModuleInstallFlags.upgrade
            );

            assert.equal(result.exe, 'uv');
            assert.deepEqual(result.args, [
                'pip',
                'install',
                '--upgrade',
                '--python',
                Uri.file('/path/to/python').fsPath,
                'jupyter'
            ]);
        });

        test('Should use path when executable.uri is not available', async () => {
            const envWithoutUri = {
                ...mockInterpreterInfo,
                executable: {
                    uri: undefined,
                    bitness: '64-bit' as const,
                    sysPrefix: '/path/to/prefix'
                }
            } as unknown as PythonEnvironment;
            getInterpreterInfoStub.resolves(envWithoutUri);

            const result = await testableInstaller.testGetExecutionArgs('jupyter', mockPythonEnvironment);

            assert.equal(result.exe, 'uv');
            assert.deepEqual(result.args, ['pip', 'install', '--python', '/path/to/python', 'jupyter']);
        });

        test('Should work with Extension Environment type', async () => {
            const mockEnvInfo = {
                uri: Uri.file('/extension/path/to/python'),
                id: 'test-env',
                path: '/extension/path/to/python',
                executable: {
                    uri: Uri.file('/extension/path/to/python'),
                    bitness: '64-bit' as const,
                    sysPrefix: '/path/to/prefix'
                }
            } as unknown as PythonEnvironment;
            getInterpreterInfoStub.resolves(mockEnvInfo);

            const result = await testableInstaller.testGetExecutionArgs('numpy', mockExtensionEnvironment);

            assert.equal(result.exe, 'uv');
            assert.deepEqual(result.args, [
                'pip',
                'install',
                '--python',
                Uri.file('/extension/path/to/python').fsPath,
                'numpy'
            ]);
        });

        test('Should carry the configured http.proxy into the environment, since uv has no --proxy flag', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);
            when(workspaceConfig.get('proxy', '')).thenReturn('http://proxy.internal:3128');

            const result = await testableInstaller.testGetExecutionArgs('numpy', mockPythonEnvironment);

            assert.deepEqual(result.env, {
                HTTPS_PROXY: 'http://proxy.internal:3128',
                HTTP_PROXY: 'http://proxy.internal:3128'
            });
            assert.notInclude(result.args, '--proxy', 'uv rejects a --proxy flag');
        });

        test('Should set no proxy environment when http.proxy is unset', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);

            const result = await testableInstaller.testGetExecutionArgs('numpy', mockPythonEnvironment);

            assert.isUndefined(result.env);
        });

        for (const name of PROXY_ENVIRONMENT_VARIABLES) {
            test(`Should leave an existing ${name} alone rather than layer the setting over it`, async () => {
                getInterpreterInfoStub.resolves(mockInterpreterInfo);
                when(workspaceConfig.get('proxy', '')).thenReturn('http://from-settings:3128');
                process.env[name] = 'http://from-environment:8080';

                const result = await testableInstaller.testGetExecutionArgs('numpy', mockPythonEnvironment);

                assert.isUndefined(result.env);
            });
        }

        test('Should throw error when interpreter info is not available', async () => {
            getInterpreterInfoStub.resolves(undefined);

            try {
                await testableInstaller.testGetExecutionArgs('jupyter', mockPythonEnvironment);
                assert.fail('Expected error to be thrown');
            } catch (error) {
                assert.include((error as Error).message, 'Unable to get interpreter information');
            }
        });
    });

    suite('Error Handling', () => {
        const mockPythonEnvironment = {
            uri: Uri.file('/path/to/python'),
            id: 'test-env',
            path: '/path/to/python'
        } as unknown as PythonEnvironment;

        const mockInterpreterInfo = {
            uri: Uri.file('/path/to/python'),
            id: 'test-env',
            path: '/path/to/python',
            executable: {
                uri: Uri.file('/path/to/python'),
                bitness: '64-bit' as const,
                sysPrefix: '/path/to/prefix'
            }
        } as unknown as PythonEnvironment;

        test('Should handle UV version check errors gracefully', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);
            when(processService.exec('uv', ['--version'], anything())).thenReject(new Error('Command failed'));

            const result = await installer.isSupported(mockPythonEnvironment);

            assert.isFalse(result);
        });

        test('Should handle empty UV version output', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);
            when(processService.exec('uv', ['--version'], anything())).thenResolve({ stdout: '', stderr: '' });

            const result = await installer.isSupported(mockPythonEnvironment);

            assert.isFalse(result);
        });

        test('Should handle process service creation failure', async () => {
            getInterpreterInfoStub.resolves(mockInterpreterInfo);
            when(processServiceFactory.create(anything())).thenReject(new Error('Failed to create process service'));

            try {
                await installer.isSupported(mockPythonEnvironment);
                assert.fail('Expected error to be thrown');
            } catch (error) {
                assert.include((error as Error).message, 'Failed to create process service');
            }
        });
    });
});
