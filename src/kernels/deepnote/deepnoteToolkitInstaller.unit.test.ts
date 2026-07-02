import { assert } from 'chai';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { CancellationTokenSource, Uri } from 'vscode';

import { DeepnoteToolkitInstaller } from './deepnoteToolkitInstaller.node';
import { IFileSystem } from '../../platform/common/platform/types';
import { IProcessService, IProcessServiceFactory } from '../../platform/common/process/types.node';
import { IExtensionContext, IOutputChannel } from '../../platform/common/types';

/**
 * Regression tests for SAL-105: "Hanging kernel can't be cancelled".
 *
 * Every processService.exec(...) in the toolkit installer must forward the
 * CancellationToken it was given. The token is what wires VS Code's Stop /
 * Cancel button to ProcessService.kill(pid) (see proc.node.ts), so omitting it
 * makes long-running pip installs uninterruptible.
 */
suite('DeepnoteToolkitInstaller - cancellation token propagation (SAL-105)', () => {
    let installer: DeepnoteToolkitInstaller;
    let mockProcessService: IProcessService;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockOutputChannel: IOutputChannel;
    let mockContext: IExtensionContext;
    let mockFs: IFileSystem;

    const venvPath = Uri.file('/fake/venv');
    const fakePython = Uri.file('/fake/venv/bin/python');

    setup(() => {
        mockProcessService = mock<IProcessService>();
        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockOutputChannel = mock<IOutputChannel>();
        mockContext = mock<IExtensionContext>();
        mockFs = mock<IFileSystem>();

        const processService = instance(mockProcessService);
        // Prevent the ts-mockito instance from being treated as a thenable when
        // resolved through a promise (see kernelProcess.node.unit.test.ts).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (processService as any).then = undefined;
        when(mockProcessServiceFactory.create(anything())).thenResolve(processService);
        when(mockProcessService.exec(anything(), anything(), anything())).thenResolve({ stdout: '', stderr: '' });

        installer = new DeepnoteToolkitInstaller(
            instance(mockProcessServiceFactory),
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

            verify(mockProcessService.exec(anything(), anything(), anything())).once();
            const [file, args, options] = capture(mockProcessService.exec).first();
            assert.deepStrictEqual(
                { file, args, options },
                {
                    file: fakePython.fsPath,
                    args: ['-m', 'pip', 'install', '--upgrade', 'some-package'],
                    options: { throwOnStdErr: false, token: cts.token }
                },
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

            verify(mockProcessService.exec(anything(), anything(), anything())).never();
        } finally {
            cts.dispose();
        }
    });

    test('ensureVenvAndToolkit forwards the cancellation token to the toolkit version probe', async () => {
        const cts = new CancellationTokenSource();

        try {
            when(mockProcessService.exec(anything(), anything(), anything())).thenResolve({
                stdout: '1.2.3\n',
                stderr: ''
            });
            // Kernel spec already installed, so the fast path runs the probe exec only
            when(mockFs.exists(anything())).thenResolve(true);

            const result = await installer.ensureVenvAndToolkit(
                { uri: fakePython, id: fakePython.fsPath },
                venvPath,
                false,
                cts.token
            );

            assert.strictEqual(result.toolkitVersion, '1.2.3');
            verify(mockProcessService.exec(anything(), anything(), anything())).once();
            const [file, args, options] = capture(mockProcessService.exec).first();
            assert.deepStrictEqual(
                { file, args, options },
                {
                    file: fakePython.fsPath,
                    args: ['-c', 'import deepnote_toolkit; print(deepnote_toolkit.__version__)'],
                    options: { token: cts.token }
                },
                'the cancellation token must be forwarded to the isToolkitInstalled probe'
            );
        } finally {
            cts.dispose();
        }
    });
});
