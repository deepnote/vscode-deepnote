// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect } from 'chai';
import * as path from '../../../platform/vscode-path/path';
import * as sinon from 'sinon';
import { TEST_LAYOUT_ROOT } from '../../../test/pythonEnvironments/constants';
import { ShellOptions, ExecutionResult } from '../../../platform/common/process/types.node';
import * as platformApis from '../../../platform/common/utils/platform';
import esmock from 'esmock';

const testPoetryDir = path.join(TEST_LAYOUT_ROOT, 'poetry');
const project1 = path.join(testPoetryDir, 'project1');
const project4 = path.join(testPoetryDir, 'project4');
const project3 = path.join(testPoetryDir, 'project3');

suite('isPoetryEnvironment Tests', () => {
    let isPoetryEnvironment: (interpreterPath: string) => Promise<boolean>;
    let mockedModule: any;
    let shellExecute: sinon.SinonStub;
    let getPythonSetting: sinon.SinonStub;
    let getOSType: sinon.SinonStub;
    let pathExistsSync: sinon.SinonStub;
    let readFileSync: sinon.SinonStub;
    let isVirtualenvEnvironment: sinon.SinonStub;

    setup(async () => {
        shellExecute = sinon.stub();
        getPythonSetting = sinon.stub();
        getOSType = sinon.stub();
        pathExistsSync = sinon.stub();
        readFileSync = sinon.stub();
        isVirtualenvEnvironment = sinon.stub();

        mockedModule = await esmock('../../../platform/interpreter/installer/poetry.node', {
            '../../../platform/common/platform/fileUtils.node': {
                shellExecute,
                getPythonSetting,
                pathExistsSync,
                readFileSync,
                arePathsSame: (p1: string, p2: string) => p1 === p2,
                getEnvironmentDirFromPath: (p: string) => path.dirname(path.dirname(p)),
                isVirtualenvEnvironment,
                pathExists: () => Promise.resolve(true)
            },
            '../../../platform/common/utils/platform': {
                getOSType,
                OSType: platformApis.OSType
            }
        });
        isPoetryEnvironment = mockedModule.isPoetryEnvironment;
        isVirtualenvEnvironment.resolves(true); // Default to true
    });

    teardown(() => {
        sinon.restore();
        esmock.purge(mockedModule);
    });

    suite('Global poetry environment', async () => {
        setup(() => {
            getOSType.returns(platformApis.OSType.Windows);
        });

        test('Return true if environment folder name matches global env pattern and environment is of virtual env type', async () => {
            const result = await isPoetryEnvironment(
                path.join(testPoetryDir, 'poetry-tutorial-project-6hnqYwvD-py3.8', 'Scripts', 'python.exe')
            );
            expect(result).to.equal(true);
        });

        test('Return false if environment folder name does not matches env pattern', async () => {
            const result = await isPoetryEnvironment(
                path.join(testPoetryDir, 'wannabeglobalenv', 'Scripts', 'python.exe')
            );
            expect(result).to.equal(false);
        });

        test('Return false if environment folder name matches env pattern but is not of virtual env type', async () => {
            isVirtualenvEnvironment.resolves(false);
            const result = await isPoetryEnvironment(
                path.join(testPoetryDir, 'project1-haha-py3.8', 'Scripts', 'python.exe')
            );
            expect(result).to.equal(false);
        });
    });

    suite('Local poetry environment', async () => {
        setup(() => {
            getPythonSetting.returns('poetry');
            shellExecute.callsFake((command: string, _options: ShellOptions) => {
                if (command === 'poetry env list --full-path') {
                    return Promise.resolve<ExecutionResult<string>>({ stdout: '' });
                }
                return Promise.reject(new Error('Command failed'));
            });
            pathExistsSync.returns(true); // Assume pyproject.toml exists and is valid for these tests
            readFileSync.returns('[tool.poetry]');
        });

        test('Return true if environment folder name matches criteria for local envs', async () => {
            getOSType.returns(platformApis.OSType.Windows);
            const result = await isPoetryEnvironment(path.join(project1, '.venv', 'Scripts', 'python.exe'));
            expect(result).to.equal(true);
        });

        test(`Return false if environment folder name is not named '.venv' for local envs`, async () => {
            getOSType.returns(platformApis.OSType.Windows);
            const result = await isPoetryEnvironment(path.join(project1, '.venv2', 'Scripts', 'python.exe'));
            expect(result).to.equal(false);
        });

        test(`Return false if running poetry for project dir as cwd fails (pyproject.toml file is invalid)`, async () => {
            getOSType.returns(platformApis.OSType.Linux);
            pathExistsSync.returns(true);
            readFileSync.returns(''); // Invalid toml
            const result = await isPoetryEnvironment(path.join(project4, '.venv', 'bin', 'python'));
            expect(result).to.equal(false);
        });
    });
});

suite('Poetry binary is located correctly', async () => {
    let Poetry: any;
    let shellExecute: sinon.SinonStub;
    let getPythonSetting: sinon.SinonStub;
    let getUserHomeDir: sinon.SinonStub;
    let pathExistsSync: sinon.SinonStub;
    let readFileSync: sinon.SinonStub;

    setup(async () => {
        shellExecute = sinon.stub();
        getPythonSetting = sinon.stub();
        getUserHomeDir = sinon.stub();
        pathExistsSync = sinon.stub();
        readFileSync = sinon.stub();

        const module = await esmock('../../../platform/interpreter/installer/poetry.node', {
            '../../../platform/common/platform/fileUtils.node': {
                shellExecute,
                getPythonSetting,
                pathExistsSync,
                readFileSync,
                arePathsSame: (p1: string, p2: string) => p1 === p2 // Simple mock for arePathsSame
            },
            '../../../platform/common/utils/platform.node': {
                getUserHomeDir
            }
        });
        Poetry = module.Poetry;
    });

    teardown(() => {
        sinon.restore();
        esmock.purge(Poetry);
    });

    test("Return undefined if pyproject.toml doesn't exist in cwd", async () => {
        getPythonSetting.returns('poetryPath');
        shellExecute.callsFake((_command: string, _options: ShellOptions) =>
            Promise.resolve<ExecutionResult<string>>({ stdout: '' })
        );
        pathExistsSync.returns(false);

        const poetry = await Poetry.getPoetry(testPoetryDir);

        expect(poetry?.command).to.equal(undefined);
    });

    test('Return undefined if cwd contains pyproject.toml which does not contain a poetry section', async () => {
        getPythonSetting.returns('poetryPath');
        shellExecute.callsFake((_command: string, _options: ShellOptions) =>
            Promise.resolve<ExecutionResult<string>>({ stdout: '' })
        );
        pathExistsSync.returns(true);
        readFileSync.returns(''); // No poetry section

        const poetry = await Poetry.getPoetry(project3);

        expect(poetry?.command).to.equal(undefined);
    });

    test('When user has specified a valid poetry path, use it', async () => {
        getPythonSetting.returns('poetryPath');
        pathExistsSync.returns(true);
        readFileSync.returns('[tool.poetry]');
        shellExecute.callsFake((command: string, options: ShellOptions) => {
            if (command === `poetryPath env list --full-path` && options.cwd && options.cwd.toString() === project1) {
                return Promise.resolve<ExecutionResult<string>>({ stdout: '' });
            }
            return Promise.reject(new Error('Command failed'));
        });

        const poetry = await Poetry.getPoetry(project1);

        expect(poetry?.command).to.equal('poetryPath');
    });

    test("When user hasn't specified a path, use poetry on PATH if available", async () => {
        getPythonSetting.returns('poetry'); // Setting returns the default value
        pathExistsSync.returns(true);
        readFileSync.returns('[tool.poetry]');
        shellExecute.callsFake((command: string, options: ShellOptions) => {
            if (command === `poetry env list --full-path` && options.cwd && options.cwd.toString() === project1) {
                return Promise.resolve<ExecutionResult<string>>({ stdout: '' });
            }
            return Promise.reject(new Error('Command failed'));
        });

        const poetry = await Poetry.getPoetry(project1);

        expect(poetry?.command).to.equal('poetry');
    });

    test('When poetry is not available on PATH, try using the default poetry location if valid', async () => {
        const home = '/users/home'; // Mock home directory
        getUserHomeDir.returns({ fsPath: home });

        const defaultPoetry = path.join(home, '.poetry', 'bin', 'poetry');
        // pathExistsSync needs to return true for defaultPoetry AND pyproject.toml
        pathExistsSync.callsFake((p: string) => {
            if (p === defaultPoetry) return true;
            if (p.endsWith('pyproject.toml')) return true;
            return false;
        });
        readFileSync.returns('[tool.poetry]');

        getPythonSetting.returns('poetry');
        shellExecute.callsFake((command: string, options: ShellOptions) => {
            if (
                command === `${defaultPoetry} env list --full-path` &&
                options.cwd &&
                options.cwd.toString() === project1
            ) {
                return Promise.resolve<ExecutionResult<string>>({ stdout: '' });
            }
            return Promise.reject(new Error('Command failed'));
        });

        const poetry = await Poetry.getPoetry(project1);

        expect(poetry?.command).to.equal(defaultPoetry);
    });

    test('Return undefined otherwise', async () => {
        getPythonSetting.returns('poetry');
        pathExistsSync.returns(true);
        readFileSync.returns('[tool.poetry]');
        shellExecute.callsFake((_command: string, _options: ShellOptions) =>
            Promise.reject(new Error('Command failed'))
        );

        const poetry = await Poetry.getPoetry(project1);

        expect(poetry?.command).to.equal(undefined);
    });
});
