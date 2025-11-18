import * as sinon from 'sinon';
import * as path from '../../../platform/vscode-path/path';
import assert from 'assert';
import { expect } from 'chai';
import { anything, instance, mock, reset, when } from 'ts-mockito';
import { Uri } from 'vscode';
import { ConfigurationService } from '../../../platform/common/configuration/service.node';
import { ExecutionResult, ShellOptions } from '../../../platform/common/process/types.node';
import { IConfigurationService, IDisposable } from '../../../platform/common/types';
import { ServiceContainer } from '../../../platform/ioc/container';
import { EnvironmentType, PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { TEST_LAYOUT_ROOT } from '../../../test/pythonEnvironments/constants';
import { JupyterSettings } from '../../../platform/common/configSettings';
import { ExecutionInstallArgs } from '../../../platform/interpreter/installer/moduleInstaller.node';
import { ModuleInstallFlags } from '../../../platform/interpreter/installer/types';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { Disposable } from 'vscode';
import { dispose } from '../../common/utils/lifecycle';
import { PythonExtension } from '@vscode/python-extension';
import { resolvableInstance } from '../../../test/datascience/helpers';
import { setPythonApi } from '../helpers';
import esmock from 'esmock';

suite('Module Installer - Poetry', () => {
    const testPoetryDir = path.join(TEST_LAYOUT_ROOT, 'poetry');
    const project1 = path.join(testPoetryDir, 'project1');
    let poetryInstaller: any;
    let configurationService: IConfigurationService;
    let serviceContainer: ServiceContainer;
    let shellExecute: sinon.SinonStub;
    let arePathsSame: sinon.SinonStub;
    let pathExistsSync: sinon.SinonStub;
    let readFileSync: sinon.SinonStub;
    let getPythonSetting: sinon.SinonStub;
    let disposables: IDisposable[] = [];
    let environments: PythonExtension['environments'];

    setup(async () => {
        resetVSCodeMocks();
        disposables.push(new Disposable(() => resetVSCodeMocks()));
        serviceContainer = mock(ServiceContainer);
        configurationService = mock(ConfigurationService);
        reset(mockedVSCodeNamespaces.workspace);
        when(configurationService.getSettings(anything())).thenReturn({} as any);

        shellExecute = sinon.stub();
        arePathsSame = sinon.stub();
        pathExistsSync = sinon.stub();
        readFileSync = sinon.stub();
        getPythonSetting = sinon.stub();

        // Mock arePathsSame to work as expected in the test logic
        arePathsSame.callsFake((p1: string, p2: string) => p1 === p2);
        pathExistsSync.returns(true);
        readFileSync.returns('[tool.poetry]');
        getPythonSetting.returns('poetry');

        shellExecute.callsFake((command: string, options: ShellOptions) => {
            // eslint-disable-next-line default-case
            switch (command) {
                case 'poetry env list --full-path':
                    return Promise.resolve<ExecutionResult<string>>({ stdout: '' });
                case 'poetry env info -p':
                    if (options.cwd && arePathsSame(options.cwd.toString(), project1)) {
                        return Promise.resolve<ExecutionResult<string>>({
                            stdout: `${path.join(project1, '.venv')} \n`
                        });
                    }
            }
            return Promise.reject(new Error('Command failed'));
        });

        const fileUtilsMock = {
            shellExecute,
            arePathsSame,
            pathExistsSync,
            readFileSync,
            getPythonSetting
        };

        const poetryNode = await esmock('../../../platform/interpreter/installer/poetry.node', {
            '../../../platform/common/platform/fileUtils.node': fileUtilsMock,
            '../../../platform/common/utils/platform': {
                getUserHomeDir: () => undefined, // Mock getUserHomeDir to avoid using real home dir
                OSType: { Windows: 'Windows', OSX: 'OSX', Linux: 'Linux' },
                getOSType: () => 'OSX'
            }
        });

        const module = await esmock('../../../platform/interpreter/installer/poetryInstaller.node', {
            '../../../platform/interpreter/installer/poetry.node': poetryNode,
            '../../../platform/common/platform/fileUtils.node': fileUtilsMock
        });

        const PoetryInstaller = module.PoetryInstaller;

        class TestInstaller extends PoetryInstaller {
            // eslint-disable-next-line @typescript-eslint/no-useless-constructor
            constructor(serviceContainer: ServiceContainer, configurationService: IConfigurationService) {
                super(serviceContainer, configurationService);
            }
            public async getExecutionArgs(
                moduleName: string,
                interpreter: PythonEnvironment,
                _flags?: ModuleInstallFlags
            ): Promise<ExecutionInstallArgs> {
                return super.getExecutionArgs(moduleName, interpreter);
            }
        }

        poetryInstaller = new TestInstaller(instance(serviceContainer), instance(configurationService));

        const mockedApi = mock<PythonExtension>();
        sinon.stub(PythonExtension, 'api').resolves(resolvableInstance(mockedApi));
        disposables.push({ dispose: () => sinon.restore() });
        environments = mock<PythonExtension['environments']>();
        when(mockedApi.environments).thenReturn(instance(environments));
        when(environments.known).thenReturn([]);
        setPythonApi(instance(mockedApi));
        disposables.push({ dispose: () => setPythonApi(undefined as any) });
    });

    teardown(() => {
        disposables = dispose(disposables);
        sinon.restore();
        // esmock.purge(poetryInstaller); // poetryInstaller is an instance, not the module.
        // We should purge the module if we kept a reference, but esmock might handle it if we don't reuse it?
        // Better to purge. But I don't have the module reference here easily unless I store it.
        // Actually esmock.purge is for the module.
    });

    test('Installer name is poetry', () => {
        expect(poetryInstaller.name).to.equal('poetry');
    });

    test('Installer priority is 10', () => {
        expect(poetryInstaller.priority).to.equal(10);
    });

    test('Installer display name is poetry', () => {
        expect(poetryInstaller.displayName).to.equal('poetry');
    });

    test('Is not supported when there is no workspace', async () => {
        const interpreter: PythonEnvironment = {
            uri: Uri.file('foobar'),
            id: Uri.file('foobar').fsPath
        };
        when(environments.known).thenReturn([
            {
                id: interpreter.id,
                tools: [EnvironmentType.Poetry]
            } as any
        ]);

        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn();

        const supported = await poetryInstaller.isSupported(interpreter);

        assert.strictEqual(supported, false);
    });
    test('Get Executable info', async () => {
        const interpreter: PythonEnvironment = {
            uri: Uri.file('foobar'),
            id: Uri.file('foobar').fsPath
        };
        when(environments.known).thenReturn([
            {
                id: interpreter.id,
                tools: [EnvironmentType.Poetry]
            } as any
        ]);

        const settings = mock(JupyterSettings);

        when(configurationService.getSettings(undefined)).thenReturn(instance(settings));
        when(settings.poetryPath).thenReturn('poetry path');

        const info = await poetryInstaller.getExecutionArgs('something', interpreter);

        assert.deepEqual(info, { args: ['poetry path', 'add', '--dev', 'something'], cwd: null, useShellExec: true });
    });
    test('Is supported returns true if selected interpreter is related to the workspace', async () => {
        const uri = Uri.file(project1);
        const settings = mock(JupyterSettings);
        const interpreter: PythonEnvironment = {
            uri: Uri.file(path.join(project1, '.venv', 'scripts', 'python.exe')),
            id: Uri.file(path.join(project1, '.venv', 'scripts', 'python.exe')).fsPath
        };
        when(environments.known).thenReturn([
            {
                id: interpreter.id,
                tools: [EnvironmentType.Poetry]
            } as any
        ]);

        when(configurationService.getSettings(anything())).thenReturn(instance(settings));
        when(settings.poetryPath).thenReturn('poetry');
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn({ uri, name: '', index: 0 });

        const supported = await poetryInstaller.isSupported(interpreter);

        assert.strictEqual(supported, true);
    });

    test('Is supported returns false if selected interpreter is not related to the workspace', async () => {
        const uri = Uri.file(project1);
        const settings = mock(JupyterSettings);
        const interpreter: PythonEnvironment = {
            uri: Uri.file('foobar'),
            id: Uri.file('foobar').fsPath
        };
        when(environments.known).thenReturn([
            {
                id: interpreter.id,
                tools: [EnvironmentType.Poetry]
            } as any
        ]);

        when(configurationService.getSettings(anything())).thenReturn(instance(settings));
        when(settings.poetryPath).thenReturn('poetry');
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn({ uri, name: '', index: 0 });

        const supported = await poetryInstaller.isSupported(interpreter);

        assert.strictEqual(supported, false);
    });

    test('Is supported returns false if selected interpreter is not of Poetry type', async () => {
        const uri = Uri.file(project1);
        const settings = mock(JupyterSettings);
        const interpreter: PythonEnvironment = {
            uri: Uri.file('foobar'),
            id: Uri.file('foobar').fsPath
        };
        when(environments.known).thenReturn([
            {
                id: interpreter.id,
                tools: [EnvironmentType.Conda]
            } as any
        ]);

        when(configurationService.getSettings(anything())).thenReturn(instance(settings));
        when(settings.poetryPath).thenReturn('poetry');
        when(mockedVSCodeNamespaces.workspace.getWorkspaceFolder(anything())).thenReturn({ uri, name: '', index: 0 });

        const supported = await poetryInstaller.isSupported(interpreter);

        assert.strictEqual(supported, false);
    });
});
