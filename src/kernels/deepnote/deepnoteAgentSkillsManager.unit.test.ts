import { assert } from 'chai';
import * as sinon from 'sinon';
import { reset, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { IProcessService, IProcessServiceFactory } from '../../platform/common/process/types.node';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getPrivateMethod = (obj: any, methodName: string) => {
    return obj[methodName].bind(obj);
};

suite('DeepnoteAgentSkillsManager', () => {
    let manager: DeepnoteAgentSkillsManager;
    let execStub: sinon.SinonStub;

    const workspaceFolder = { uri: Uri.file('/workspace/my-project') };

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/home/user/.venvs/test-venv/bin/python')
    } as PythonEnvironment;

    function configureVSCodeMocks(appName: string, workspaceFolders?: any[]) {
        resetVSCodeMocks();
        reset(mockedVSCodeNamespaces.env);
        reset(mockedVSCodeNamespaces.workspace);

        when(mockedVSCodeNamespaces.env.appName).thenReturn(appName);
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(workspaceFolders as any);
    }

    setup(() => {
        configureVSCodeMocks('Cursor', [workspaceFolder]);

        execStub = sinon.stub().resolves({ stdout: '', stderr: '' });

        const stubProcessService = { exec: execStub } as unknown as IProcessService;
        const stubFactory = {
            create: sinon.stub().resolves(stubProcessService)
        } as unknown as IProcessServiceFactory;

        manager = new DeepnoteAgentSkillsManager(stubFactory);
    });

    suite('updateSkillsInBackground', () => {
        test('should run pip upgrade then install-skills', async () => {
            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.strictEqual(execStub.callCount, 2);

            const [executable, args] = execStub.firstCall.args;

            assert.strictEqual(executable, testInterpreter.uri.fsPath);
            assert.deepStrictEqual(args, ['-m', 'pip', 'install', '--upgrade', 'deepnote-cli']);
        });

        test('should call install-skills with correct agent and cwd', async () => {
            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            const [executable, args, options] = execStub.secondCall.args;
            const expectedBin = Uri.joinPath(testInterpreter.uri, '..', 'deepnote').fsPath;

            assert.strictEqual(executable, expectedBin);
            assert.deepStrictEqual(args, ['install-skills', '--agent', 'cursor']);
            assert.strictEqual(options.cwd, workspaceFolder.uri.fsPath);
        });
    });

    suite('session-scoped deduplication', () => {
        test('should mark environment as processed after first call', () => {
            manager.ensureSkillsUpdated('env-1', testInterpreter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const processed = (manager as any).processedEnvironments as Set<string>;

            assert.isTrue(processed.has('env-1'));
        });

        test('should track different environments separately', () => {
            manager.ensureSkillsUpdated('env-1', testInterpreter);
            manager.ensureSkillsUpdated('env-2', testInterpreter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const processed = (manager as any).processedEnvironments as Set<string>;

            assert.isTrue(processed.has('env-1'));
            assert.isTrue(processed.has('env-2'));
            assert.strictEqual(processed.size, 2);
        });

        test('should not add duplicate entries for the same environment', () => {
            manager.ensureSkillsUpdated('env-1', testInterpreter);
            manager.ensureSkillsUpdated('env-1', testInterpreter);
            manager.ensureSkillsUpdated('env-1', testInterpreter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const processed = (manager as any).processedEnvironments as Set<string>;

            assert.strictEqual(processed.size, 1);
        });
    });

    suite('editor detection', () => {
        test('should detect Cursor', async () => {
            configureVSCodeMocks('Cursor', [workspaceFolder]);
            manager = new DeepnoteAgentSkillsManager(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (manager as any).processServiceFactory
            );

            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.deepStrictEqual(execStub.secondCall.args[1], ['install-skills', '--agent', 'cursor']);
        });

        test('should detect Windsurf', async () => {
            configureVSCodeMocks('Windsurf', [workspaceFolder]);
            manager = new DeepnoteAgentSkillsManager(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (manager as any).processServiceFactory
            );

            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.deepStrictEqual(execStub.secondCall.args[1], ['install-skills', '--agent', 'windsurf']);
        });

        test('should default to github copilot for VS Code', async () => {
            configureVSCodeMocks('Visual Studio Code', [workspaceFolder]);
            manager = new DeepnoteAgentSkillsManager(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (manager as any).processServiceFactory
            );

            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.deepStrictEqual(execStub.secondCall.args[1], ['install-skills', '--agent', 'github copilot']);
        });

        test('should default to github copilot for unknown editors', async () => {
            configureVSCodeMocks('SomeUnknownEditor', [workspaceFolder]);
            manager = new DeepnoteAgentSkillsManager(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (manager as any).processServiceFactory
            );

            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.deepStrictEqual(execStub.secondCall.args[1], ['install-skills', '--agent', 'github copilot']);
        });
    });

    suite('edge cases', () => {
        test('should skip when no workspace folder is open', async () => {
            configureVSCodeMocks('Cursor', undefined);
            manager = new DeepnoteAgentSkillsManager(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (manager as any).processServiceFactory
            );

            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should skip when workspace folders array is empty', async () => {
            configureVSCodeMocks('Cursor', []);
            manager = new DeepnoteAgentSkillsManager(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (manager as any).processServiceFactory
            );

            const updateSkills: (interpreter: PythonEnvironment) => Promise<void> = getPrivateMethod(
                manager,
                'updateSkillsInBackground'
            );

            await updateSkills(testInterpreter);

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should swallow errors in ensureSkillsUpdated', () => {
            execStub.rejects(new Error('pip failure'));

            // ensureSkillsUpdated is fire-and-forget -- it must not throw
            manager.ensureSkillsUpdated('env-error', testInterpreter);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const processed = (manager as any).processedEnvironments as Set<string>;

            assert.isTrue(processed.has('env-error'));
        });
    });
});
