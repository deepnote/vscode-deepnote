import { assert } from 'chai';
import { anything, instance, mock, when } from 'ts-mockito';
import { CancellationToken, CancellationTokenSource, Uri } from 'vscode';

import { DeepnoteToolkitInstaller } from './deepnoteToolkitInstaller.node';
import { IFileSystem } from '../../platform/common/platform/types';
import { ExecutionResult, IProcessService, IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IExtensionContext, IOutputChannel } from '../../platform/common/types';

/**
 * Regression test for SAL-105: "Hanging kernel can't be cancelled".
 *
 * Every processService.exec(...) in the toolkit installer must forward the
 * CancellationToken it was given. The token is what wires VS Code's Stop /
 * Cancel button to ProcessService.kill(pid) (see proc.node.ts), so omitting it
 * makes long-running pip installs uninterruptible.
 *
 * The process layer is hand-rolled (rather than ts-mockito) because the real
 * code calls create(undefined) / exec(...) and ts-mockito argument matchers
 * behave unreliably for interface mocks here, returning never-resolving stubs.
 */
suite('DeepnoteToolkitInstaller - cancellation token propagation (SAL-105)', () => {
    type ExecCall = { file: string; args: string[]; options?: { token?: CancellationToken } };

    let installer: DeepnoteToolkitInstaller;
    let execCalls: ExecCall[];
    let mockOutputChannel: IOutputChannel;
    let mockContext: IExtensionContext;
    let mockFs: IFileSystem;

    const venvPath = Uri.file('/fake/venv');
    const fakePython = Uri.file('/fake/venv/bin/python');

    setup(() => {
        execCalls = [];
        mockOutputChannel = mock<IOutputChannel>();
        mockContext = mock<IExtensionContext>();
        mockFs = mock<IFileSystem>();

        when(mockOutputChannel.appendLine(anything())).thenReturn();

        const fakeProcessService = {
            exec: async (
                file: string,
                args: string[],
                options?: { token?: CancellationToken }
            ): Promise<ExecutionResult<string>> => {
                execCalls.push({ file, args, options });

                return { stdout: '', stderr: '' };
            }
        } as unknown as IProcessService;

        const fakeProcessServiceFactory = {
            create: async () => fakeProcessService
        } as unknown as IProcessServiceFactory;

        installer = new DeepnoteToolkitInstaller(
            fakeProcessServiceFactory,
            instance(mockOutputChannel),
            instance(mockContext),
            instance(mockFs)
        );

        // Seed the interpreter cache so getVenvInterpreterByPath() resolves
        // without touching the real filesystem / resolvePythonExecutable.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (installer as any).venvPythonPaths.set(venvPath.fsPath, fakePython);
    });

    test('installAdditionalPackages forwards the cancellation token to processService.exec', async () => {
        const cts = new CancellationTokenSource();

        try {
            await installer.installAdditionalPackages(venvPath, ['some-package'], cts.token);

            assert.strictEqual(execCalls.length, 1, 'exec should be called exactly once');

            const call = execCalls[0];
            assert.strictEqual(call.file, fakePython.fsPath);
            assert.include(call.args, 'pip', 'should run a pip install');
            assert.isDefined(call.options, 'exec options should be provided');
            assert.strictEqual(
                call.options!.token,
                cts.token,
                'the cancellation token must be forwarded to exec so Stop can kill the process'
            );
        } finally {
            cts.dispose();
        }
    });

    test('installAdditionalPackages does not call exec when no packages are requested', async () => {
        const cts = new CancellationTokenSource();

        try {
            await installer.installAdditionalPackages(venvPath, [], cts.token);

            assert.strictEqual(execCalls.length, 0, 'exec should not be called for an empty package list');
        } finally {
            cts.dispose();
        }
    });
});
