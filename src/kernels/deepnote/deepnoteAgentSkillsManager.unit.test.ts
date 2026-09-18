import { assert } from 'chai';
import * as sinon from 'sinon';
import { reset, when } from 'ts-mockito';
import { Uri } from 'vscode';

import { fileUtilsNodeUtils } from '../../platform/common/platform/fileUtils.node';
import { IProcessService, IProcessServiceFactory } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../test/vscode-mock';
import { BUNDLED_CLI_PATH, DeepnoteAgentSkillsManager } from './deepnoteAgentSkillsManager.node';

suite('DeepnoteAgentSkillsManager', () => {
    let manager: DeepnoteAgentSkillsManager;
    let execStub: sinon.SinonStub;
    let pathExistsStub: sinon.SinonStub;

    const workspaceFolder = { uri: Uri.file('/workspace/my-project') };

    function configureVSCodeMocks(appName: string, workspaceFolders?: unknown[]) {
        resetVSCodeMocks();
        reset(mockedVSCodeNamespaces.env);
        reset(mockedVSCodeNamespaces.workspace);

        when(mockedVSCodeNamespaces.env.appName).thenReturn(appName);
        when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn(workspaceFolders as never);
    }

    setup(() => {
        configureVSCodeMocks('Cursor', [workspaceFolder]);

        pathExistsStub = sinon.stub(fileUtilsNodeUtils, 'pathExists').resolves(true);
        execStub = sinon.stub().resolves({ stdout: '', stderr: '' });

        const stubProcessService = { exec: execStub } as unknown as IProcessService;
        const stubFactory = {
            create: sinon.stub().resolves(stubProcessService)
        } as unknown as IProcessServiceFactory;

        manager = new DeepnoteAgentSkillsManager(stubFactory);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('updateSkillsInBackground', () => {
        test('runs the bundled CLI on the editor Node, and nothing through pip', async () => {
            await manager.ensureSkillsUpdated();

            assert.strictEqual(execStub.callCount, 1, 'one spawn: no pip install precedes install-skills any more');

            const [executable, args, options] = execStub.firstCall.args;

            assert.strictEqual(executable, process.execPath);
            assert.deepStrictEqual(args, [BUNDLED_CLI_PATH, 'install-skills', '--agent', 'cursor']);
            assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, '1', 'the Electron binary has to run as plain Node');
            assert.match(BUNDLED_CLI_PATH, /dist[\\/]deepnoteCli\.cjs$/);
        });

        test('installs into the workspace folder', async () => {
            await manager.ensureSkillsUpdated();

            const [, , options] = execStub.firstCall.args;

            assert.strictEqual(options.cwd, workspaceFolder.uri.fsPath);
        });

        test('never spawns a Python, and never pip', async () => {
            await manager.ensureSkillsUpdated();

            for (const call of execStub.getCalls()) {
                assert.strictEqual(call.args[0], process.execPath);
                assert.notInclude(call.args[1], 'pip');
            }
        });
    });

    suite('session-scoped deduplication', () => {
        test('should install once per workspace folder however often it is called', async () => {
            await manager.ensureSkillsUpdated();
            await manager.ensureSkillsUpdated();
            await manager.ensureSkillsUpdated();

            assert.strictEqual(execStub.callCount, 1);
        });

        test('should install again once the workspace folder changes', async () => {
            await manager.ensureSkillsUpdated();

            configureVSCodeMocks('Cursor', [{ uri: Uri.file('/workspace/other-project') }]);
            await manager.ensureSkillsUpdated();

            assert.strictEqual(execStub.callCount, 2);
        });
    });

    suite('editor detection', () => {
        async function assertAgent(appName: string, expected: string): Promise<void> {
            configureVSCodeMocks(appName, [workspaceFolder]);

            await manager.ensureSkillsUpdated();

            assert.deepStrictEqual(execStub.lastCall.args[1], [
                BUNDLED_CLI_PATH,
                'install-skills',
                '--agent',
                expected
            ]);
        }

        test('should detect Cursor', async () => {
            await assertAgent('Cursor', 'cursor');
        });

        test('should detect Windsurf', async () => {
            await assertAgent('Windsurf', 'windsurf');
        });

        test('should detect Antigravity', async () => {
            await assertAgent('Antigravity', 'antigravity');
        });

        test('should default to github copilot for VS Code', async () => {
            await assertAgent('Visual Studio Code', 'github copilot');
        });

        test('should default to github copilot for unknown editors', async () => {
            await assertAgent('SomeUnknownEditor', 'github copilot');
        });
    });

    suite('edge cases', () => {
        test('should skip when no workspace folder is open', async () => {
            configureVSCodeMocks('Cursor', undefined);

            await manager.ensureSkillsUpdated();

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should skip when workspace folders array is empty', async () => {
            configureVSCodeMocks('Cursor', []);

            await manager.ensureSkillsUpdated();

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should skip when the bundled CLI is missing', async () => {
            pathExistsStub.resolves(false);

            await manager.ensureSkillsUpdated();

            assert.strictEqual(execStub.callCount, 0);
        });

        test('should swallow install failures instead of rejecting', async () => {
            const warnStub = sinon.stub(logger, 'warn');

            execStub.rejects(new Error('spawn failure'));

            await manager.ensureSkillsUpdated();

            assert.strictEqual(warnStub.callCount, 1);
        });
    });
});
