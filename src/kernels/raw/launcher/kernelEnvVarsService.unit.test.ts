// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/* eslint-disable  */

import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { IFileSystemNode } from '../../../platform/common/platform/types.node';
import { EnvironmentVariablesService } from '../../../platform/common/variables/environment.node';
import { ICustomEnvironmentVariablesProvider } from '../../../platform/common/variables/types';
import { IEnvironmentActivationService } from '../../../platform/interpreter/activation/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import { EnvironmentType, PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { anything, instance, mock, when } from 'ts-mockito';
import { KernelEnvironmentVariablesService } from './kernelEnvVarsService.node';
import { IJupyterKernelSpec } from '../../types';
import { Uri } from 'vscode';
import { IConfigurationService, IWatchableJupyterSettings, type ReadWrite } from '../../../platform/common/types';
import { JupyterSettings } from '../../../platform/common/configSettings';
import { SqlIntegrationEnvironmentVariablesProvider } from '../../../platform/notebooks/deepnote/sqlIntegrationEnvironmentVariablesProvider';

use(chaiAsPromised);

suite('Kernel Environment Variables Service', () => {
    let fs: IFileSystemNode;
    let envActivation: IEnvironmentActivationService;
    let customVariablesService: ICustomEnvironmentVariablesProvider;
    let variablesService: EnvironmentVariablesService;
    let kernelVariablesService: KernelEnvironmentVariablesService;
    let interpreterService: IInterpreterService;
    let configService: IConfigurationService;
    let settings: IWatchableJupyterSettings;
    let sqlIntegrationEnvVars: SqlIntegrationEnvironmentVariablesProvider;
    const pathFile = Uri.joinPath(Uri.file('foobar'), 'bar');
    const interpreter: PythonEnvironment = {
        uri: pathFile,
        id: pathFile.fsPath
    };
    let kernelSpec: ReadWrite<IJupyterKernelSpec>;
    let processEnv: NodeJS.ProcessEnv;
    const originalEnvVars = Object.assign({}, process.env);
    let processPath: string | undefined;
    setup(() => {
        kernelSpec = {
            name: 'kernel',
            executable: pathFile.fsPath,
            display_name: 'kernel',
            interpreterPath: pathFile.fsPath,
            argv: []
        };
        fs = mock<IFileSystemNode>();
        envActivation = mock<IEnvironmentActivationService>();
        customVariablesService = mock<ICustomEnvironmentVariablesProvider>();
        interpreterService = mock<IInterpreterService>();
        variablesService = new EnvironmentVariablesService(instance(fs));
        configService = mock<IConfigurationService>();
        settings = mock(JupyterSettings);
        sqlIntegrationEnvVars = mock<SqlIntegrationEnvironmentVariablesProvider>();
        when(configService.getSettings(anything())).thenReturn(instance(settings));
        if (process.platform === 'win32') {
            // Win32 will generate upper case all the time
            const entries = Object.entries(process.env);
            processEnv = {};
            for (const [key, value] of entries) {
                processEnv[key.toUpperCase()] = value;
            }
        } else {
            processEnv = process.env;
        }
        processPath = Object.keys(processEnv).find((k) => k.toLowerCase() == 'path');
        kernelVariablesService = buildKernelEnvVarsService();
    });

    teardown(() => Object.assign(process.env, originalEnvVars));

    /**
     * Helper factory function to build KernelEnvironmentVariablesService with optional overrides.
     * @param overrides Optional overrides for the service dependencies
     * @returns A new instance of KernelEnvironmentVariablesService
     */
    function buildKernelEnvVarsService(overrides?: {
        sqlIntegrationEnvVars?: SqlIntegrationEnvironmentVariablesProvider | undefined;
    }): KernelEnvironmentVariablesService {
        const sqlProvider =
            overrides && 'sqlIntegrationEnvVars' in overrides
                ? overrides.sqlIntegrationEnvVars
                : instance(sqlIntegrationEnvVars);

        return new KernelEnvironmentVariablesService(
            instance(interpreterService),
            instance(envActivation),
            variablesService,
            instance(customVariablesService),
            instance(configService),
            sqlProvider
        );
    }

    test('Python Interpreter path trumps process', async () => {
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobar'
        });
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything())).thenResolve({
            PATH: 'foobar'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve();
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything())).thenResolve();
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, interpreter, kernelSpec);

        assert.isOk(processPath);
        assert.strictEqual(vars![processPath!], `foobar`);
    });
    test('Interpreter env variable trumps process', async () => {
        process.env['HELLO_VAR'] = 'process';
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            HELLO_VAR: 'new'
        });
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything())).thenResolve({
            HELLO_VAR: 'new'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve();
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything())).thenResolve();
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, interpreter, kernelSpec);

        assert.strictEqual(vars!['HELLO_VAR'], 'new');
        // Compare ignoring the PATH variable.
        assert.deepEqual(
            Object.assign(vars!, { PATH: '', Path: '' }),
            Object.assign({}, processEnv, { HELLO_VAR: 'new' }, { PATH: '', Path: '' })
        );
    });

    test('Custom env variable will not be merged manually, rely on Python extension to return them trumps process and interpreter envs', async () => {
        process.env['HELLO_VAR'] = 'process';
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            HELLO_VAR: 'interpreter'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            HELLO_VAR: 'new'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, interpreter, kernelSpec);

        assert.strictEqual(vars!['HELLO_VAR'], 'interpreter');
        // Compare ignoring the PATH variable.
        assert.deepEqual(vars, Object.assign({}, processEnv, { HELLO_VAR: 'interpreter' }));
    });

    test('Custom env variable trumps process (non-python)', async () => {
        process.env['HELLO_VAR'] = 'very old';
        delete kernelSpec.interpreterPath;
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({});
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            HELLO_VAR: 'new'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, undefined, kernelSpec);

        assert.strictEqual(vars!['HELLO_VAR'], 'new');
        // Compare ignoring the PATH variable.
        assert.deepEqual(
            Object.assign(vars!, { PATH: '', Path: '' }),
            Object.assign({}, processEnv, { HELLO_VAR: 'new' }, { PATH: '', Path: '' })
        );
    });

    test('Returns process.env vars if no interpreter and no kernelspec.env', async () => {
        delete kernelSpec.interpreterPath;
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve();
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, undefined, kernelSpec);

        assert.deepEqual(vars, processEnv);
    });

    test('Paths are left unaltered if Python returns the Interpreter Info', async () => {
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobar'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobaz'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, interpreter, kernelSpec);
        assert.isOk(processPath);
        assert.strictEqual(vars![processPath!], `foobar`);
    });

    test('KernelSpec interpreterPath used if interpreter is undefined', async () => {
        when(interpreterService.getInterpreterDetails(anything(), anything())).thenResolve({
            uri: Uri.joinPath(Uri.file('env'), 'foopath'),
            id: Uri.joinPath(Uri.file('env'), 'foopath').fsPath
        });
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'pathInInterpreterEnv'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobaz'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

        // undefined for interpreter here, interpreterPath from the spec should be used
        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, undefined, kernelSpec);
        assert.isOk(processPath);
        assert.strictEqual(vars![processPath!], `pathInInterpreterEnv`);
    });

    test('No substitution of env variables in kernelSpec', async () => {
        when(interpreterService.getInterpreterDetails(anything(), anything())).thenResolve({
            uri: Uri.joinPath(Uri.file('env'), 'foopath'),
            id: Uri.joinPath(Uri.file('env'), 'foopath').fsPath
        });
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'pathInInterpreterEnv'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobaz'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve(undefined as any);
        kernelSpec.env = {
            ONE: '1',
            TWO: '2'
        };
        // undefined for interpreter here, interpreterPath from the spec should be used
        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, undefined, kernelSpec);
        assert.strictEqual(vars!['ONE'], `1`);
        assert.strictEqual(vars!['TWO'], `2`);
    });
    test('substitute env variables in kernelSpec', async () => {
        when(interpreterService.getInterpreterDetails(anything(), anything())).thenResolve({
            uri: Uri.joinPath(Uri.file('env'), 'foopath'),
            id: Uri.joinPath(Uri.file('env'), 'foopath').fsPath
        });
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'pathInInterpreterEnv'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobaz'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve(undefined as any);
        kernelSpec.env = {
            ONE: '1',
            TWO: '2',
            THREE: 'HELLO_${ONE}',
            PATH: 'some_path;${PATH};${ONE}'
        };
        // undefined for interpreter here, interpreterPath from the spec should be used
        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, undefined, kernelSpec);
        assert.strictEqual(vars!['ONE'], `1`);
        assert.strictEqual(vars!['TWO'], `2`);
        assert.strictEqual(vars!['THREE'], `HELLO_1`);
        assert.strictEqual(vars!['PATH'], `some_path;pathInInterpreterEnv;1`);
    });

    async function testPYTHONNOUSERSITE(_envType: EnvironmentType, shouldBeSet: boolean) {
        when(interpreterService.getInterpreterDetails(anything(), anything())).thenResolve({
            uri: Uri.file('foopath'),
            id: Uri.file('foopath').fsPath
        });
        when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobar'
        });
        when(customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())).thenResolve({
            PATH: 'foobaz'
        });
        when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});
        when(settings.excludeUserSitePackages).thenReturn(shouldBeSet);

        // undefined for interpreter here, interpreterPath from the spec should be used
        const vars = await kernelVariablesService.getEnvironmentVariables(undefined, undefined, kernelSpec);

        if (shouldBeSet) {
            assert.isOk(vars!['PYTHONNOUSERSITE'], 'PYTHONNOUSERSITE should be set');
        } else {
            assert.isUndefined(vars!['PYTHONNOUSERSITE'], 'PYTHONNOUSERSITE should not be set');
        }
    }

    test('PYTHONNOUSERSITE should not be set for Global Interpreters', async () => {
        await testPYTHONNOUSERSITE(EnvironmentType.Unknown, false);
    });
    test('PYTHONNOUSERSITE should be set for Conda Env', async () => {
        await testPYTHONNOUSERSITE(EnvironmentType.Conda, true);
    });
    test('PYTHONNOUSERSITE should be set for Virtual Env', async () => {
        await testPYTHONNOUSERSITE(EnvironmentType.VirtualEnv, true);
    });

    suite('SQL Integration Environment Variables', () => {
        test('SQL integration env vars are merged for Python kernels', async () => {
            const resource = Uri.file('test.ipynb');
            when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
                PATH: 'foobar'
            });
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();
            when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({
                SQL_MY_DB: '{"url":"postgresql://user:pass@host:5432/db","params":{},"param_style":"format"}'
            });

            const vars = await kernelVariablesService.getEnvironmentVariables(resource, interpreter, kernelSpec);

            assert.strictEqual(
                vars!['SQL_MY_DB'],
                '{"url":"postgresql://user:pass@host:5432/db","params":{},"param_style":"format"}'
            );
        });

        test('SQL integration env vars are merged for non-Python kernels', async () => {
            const resource = Uri.file('test.ipynb');
            delete kernelSpec.interpreterPath;
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();
            when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({
                SQL_MY_DB: '{"url":"postgresql://user:pass@host:5432/db","params":{},"param_style":"format"}'
            });

            const vars = await kernelVariablesService.getEnvironmentVariables(resource, undefined, kernelSpec);

            assert.strictEqual(
                vars!['SQL_MY_DB'],
                '{"url":"postgresql://user:pass@host:5432/db","params":{},"param_style":"format"}'
            );
        });

        test('SQL integration env vars are not added when provider returns empty object', async () => {
            const resource = Uri.file('test.ipynb');
            when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
                PATH: 'foobar'
            });
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();
            when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

            const vars = await kernelVariablesService.getEnvironmentVariables(resource, interpreter, kernelSpec);

            assert.isUndefined(vars!['SQL_MY_DB']);
        });

        test('SQL integration env vars are not added when provider returns undefined', async () => {
            const resource = Uri.file('test.ipynb');
            when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
                PATH: 'foobar'
            });
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();
            when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({});

            const vars = await kernelVariablesService.getEnvironmentVariables(resource, interpreter, kernelSpec);

            assert.isUndefined(vars!['SQL_MY_DB']);
        });

        test('Multiple SQL integration env vars are merged correctly', async () => {
            const resource = Uri.file('test.ipynb');
            when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
                PATH: 'foobar'
            });
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();
            when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenResolve({
                SQL_MY_DB: '{"url":"postgresql://user:pass@host:5432/db","params":{},"param_style":"format"}',
                SQL_ANOTHER_DB: '{"url":"postgresql://user2:pass2@host2:5432/db2","params":{},"param_style":"format"}'
            });

            const vars = await kernelVariablesService.getEnvironmentVariables(resource, interpreter, kernelSpec);

            assert.strictEqual(
                vars!['SQL_MY_DB'],
                '{"url":"postgresql://user:pass@host:5432/db","params":{},"param_style":"format"}'
            );
            assert.strictEqual(
                vars!['SQL_ANOTHER_DB'],
                '{"url":"postgresql://user2:pass2@host2:5432/db2","params":{},"param_style":"format"}'
            );
        });

        test('SQL integration env vars work when provider is undefined (optional dependency)', async () => {
            const resource = Uri.file('test.ipynb');
            when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
                PATH: 'foobar'
            });
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();

            // Create service without SQL integration provider
            const serviceWithoutSql = buildKernelEnvVarsService({ sqlIntegrationEnvVars: undefined });

            const vars = await serviceWithoutSql.getEnvironmentVariables(resource, interpreter, kernelSpec);

            assert.isOk(vars);
            assert.isUndefined(vars!['SQL_MY_DB']);
        });

        test('SQL integration env vars handle errors gracefully', async () => {
            const resource = Uri.file('test.ipynb');
            when(envActivation.getActivatedEnvironmentVariables(anything(), anything(), anything())).thenResolve({
                PATH: 'foobar'
            });
            when(
                customVariablesService.getCustomEnvironmentVariables(anything(), anything(), anything())
            ).thenResolve();
            when(sqlIntegrationEnvVars.getEnvironmentVariables(anything(), anything())).thenReject(
                new Error('Failed to get SQL env vars')
            );

            const vars = await kernelVariablesService.getEnvironmentVariables(resource, interpreter, kernelSpec);

            // Should still return vars without SQL integration vars
            assert.isOk(vars);
            assert.isUndefined(vars!['SQL_MY_DB']);
        });
    });
});
