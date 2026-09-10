import { assert } from 'chai';
import * as sinon from 'sinon';
import { reset, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { IProcessService, IProcessServiceFactory } from '../../platform/common/process/types.node';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { BUNDLED_CLI_PATH, DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';

suite('DeepnoteAgentSkillsManager', () => {
    let manager: DeepnoteAgentSkillsManager;
    let execStub: sinon.SinonStub;

    const workspaceFolder = { uri: Uri.file('/workspace/my-project') };

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/home/user/.venvs/test-venv/bin/python')
    } as PythonEnvironment;

    function configureVSCodeMocks(appName: string, workspaceFolders?: unknown[]) {
        resetVSCodeMocks();
        reset(mockedVSCodeNamespaces.env);
        reset(mockedVSCodeNamespaces.workspace);

        when(mockedVSCodeNamespaces.env.appName).thenReturn(appName);
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(workspaceFolders as never);
    }

    /** Runs the (private) install for `interpreter` to completion. */
    function updateSkills(interpreter: PythonEnvironment): Promise<void> {
        return (
            manager as unknown as { updateSkillsInBackground(i: PythonEnvironment): Promise<void> }
        ).updateSkillsInBackground(interpreter);
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
        test('runs the bundled CLI on the editor Node, and nothing through pip', async () => {
            await updateSkills(testInterpreter);

            assert.strictEqual(execStub.callCount, 1, 'one spawn: no pip install precedes install-skills any more');

            const [executable, args, options] = execStub.firstCall.args;

            assert.strictEqual(executable, process.execPath);
            assert.deepStrictEqual(args, [BUNDLED_CLI_PATH, 'install-skills', '--agent', 'cursor']);
            assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, '1', 'the Electron binary has to run as plain Node');
            assert.match(BUNDLED_CLI_PATH, /dist[\\/]deepnoteCli\.cjs$/);
        });

        test('installs into the workspace folder, and tells the CLI which interpreter the project runs on', async () => {
            await updateSkills(testInterpreter);

            const [, , options] = execStub.firstCall.args;

            assert.strictEqual(options.cwd, workspaceFolder.uri.fsPath);
            assert.strictEqual(options.env.DEEPNOTE_PYTHON, testInterpreter.uri.fsPath);
        });

        test('never touches the interpreter itself', async () => {
            await updateSkills(testInterpreter);

            for (const call of execStub.getCalls()) {
                assert.notStrictEqual(call.args[0], testInterpreter.uri.fsPath, 'no python -m pip ...');
                assert.notInclude(call.args[1], 'pip');
            }
        });
    });

    suite('session-scoped deduplication', () => {
        test('should mark environment as processed after first call', () => {
            manager.ensureSkillsUpdated('env-1', testInterpreter);

            const processed = (manager as unknown as { processedEnvironments: Set<string> }).processedEnvironments;

            assert.isTrue(processed.has('env-1'));
        });

        test('should track different environments separately', () => {
            manager.ensureSkillsUpdated('env-1', testInterpreter);
            manager.ensureSkillsUpdated('env-2', testInterpreter);

            const processed = (manager as unknown as { processedEnvironments: Set<string> }).processedEnvironments;

            assert.isTrue(processed.has('env-1'));
            assert.isTrue(processed.has('env-2'));
            assert.strictEqual(processed.size, 2);
        });

        test('should not add duplicate entries for the same environment', () => {
            manager.ensureSkillsUpdated('env-1', testInterpreter);
            manager.ensureSkillsUpdated('env-1', testInterpreter);
            manager.ensureSkillsUpdated('env-1', testInterpreter);

            const processed = (manager as unknown as { processedEnvironments: Set<string> }).processedEnvironments;

            assert.strictEqual(processed.size, 1);
        });
    });

    suite('editor detection', () => {
        async function agentFor(appName: string): Promise<string> {
            configureVSCodeMocks(appName, [workspaceFolder]);
            await updateSkills(testInterpreter);

            return execStub.lastCall.args[1][3];
        }

        test('should detect Cursor', async () => {
            assert.strictEqual(await agentFor('Cursor'), 'cursor');
        });

        test('should detect Windsurf', async () => {
            assert.strictEqual(await agentFor('Windsurf'), 'windsurf');
        });

        test('should detect Antigravity', async () => {
            assert.strictEqual(await agentFor('Antigravity'), 'antigravity');
        });

        test('should default to github copilot for VS Code', async () => {
            assert.strictEqual(await agentFor('Visual Studio Code'), 'github copilot');
        });

        test('should default to github copilot for unknown editors', async () => {
            assert.strictEqual(await agentFor('SomeUnknownEditor'), 'github copilot');
        });
    });

    suite('edge cases', () => {
        test('should skip when no workspace folder is open', async () => {
            configureVSCodeMocks('Cursor', undefined);

            await updateSkills(testInterpreter);

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should skip when workspace folders array is empty', async () => {
            configureVSCodeMocks('Cursor', []);

            await updateSkills(testInterpreter);

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should swallow errors in ensureSkillsUpdated', () => {
            execStub.rejects(new Error('spawn failure'));

            // ensureSkillsUpdated is fire-and-forget -- it must not throw
            manager.ensureSkillsUpdated('env-error', testInterpreter);

            const processed = (manager as unknown as { processedEnvironments: Set<string> }).processedEnvironments;

            assert.isTrue(processed.has('env-error'));
        });
    });
});
