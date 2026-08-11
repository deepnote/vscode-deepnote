import { assert } from 'chai';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { CancellationError, CancellationTokenSource, Uri } from 'vscode';

import { DeepnoteToolkitInstaller } from './deepnoteToolkitInstaller.node';
import { DeepnoteToolkitInstallError, DeepnoteToolkitMissingError } from '../../platform/errors/deepnoteKernelErrors';
import {
    ExecutionResult,
    IProcessService,
    IProcessServiceFactory,
    SpawnOptions
} from '../../platform/common/process/types.node';
import { IFileSystem } from '../../platform/common/platform/types';
import { IExtensionContext, IOutputChannel } from '../../platform/common/types';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';

/**
 * Two invariants, both easy to regress:
 *
 * 1. Every exec must carry the token — that is what wires Stop to ProcessService.kill(pid)
 *    (see proc.node.ts), and without it a multi-minute pip install is uninterruptible.
 * 2. A killed subprocess still *resolves* exec, so every outcome must be re-checked afterwards.
 */
suite('DeepnoteToolkitInstaller - cancellation', () => {
    const globalStorage = Uri.file('/fake/storage');
    const managedVenvPath = Uri.joinPath(globalStorage, 'deepnote-venvs', 'venv_abc123');
    const venvPath = Uri.file('/fake/venv');
    const fakePython = Uri.file('/fake/venv/bin/python');
    const venvInterpreter: PythonEnvironment = { uri: fakePython, id: fakePython.fsPath };
    const baseInterpreter: PythonEnvironment = { uri: Uri.file('/usr/bin/python3'), id: '/usr/bin/python3' };

    let installer: DeepnoteToolkitInstaller;
    let mockProcessService: IProcessService;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockOutputChannel: IOutputChannel;
    let mockContext: IExtensionContext;
    let mockFs: IFileSystem;
    let cts: CancellationTokenSource;

    async function rejection(promise: Promise<unknown>): Promise<unknown> {
        return promise.then(
            () => undefined,
            (ex) => ex
        );
    }

    function killExecViaToken(): void {
        when(mockProcessService.exec(anything(), anything(), anything())).thenCall(async () => {
            cts.cancel();
            return { stdout: '', stderr: '' };
        });
    }

    /** Without this the subject calls the real resolvePythonExecutable, which finds no venv on disk. */
    function seedInterpreterCache(path: Uri): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (installer as any).venvPythonPaths.set(path.fsPath, fakePython);
    }

    setup(() => {
        mockProcessService = mock<IProcessService>();
        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockOutputChannel = mock<IOutputChannel>();
        mockContext = mock<IExtensionContext>();
        mockFs = mock<IFileSystem>();
        cts = new CancellationTokenSource();

        const processService = instance(mockProcessService);
        // Prevent the ts-mockito instance from being treated as a thenable when
        // resolved through a promise (see kernelProcess.node.unit.test.ts).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (processService as any).then = undefined;
        when(mockProcessServiceFactory.create(anything())).thenResolve(processService);
        when(mockProcessService.exec(anything(), anything(), anything())).thenResolve({ stdout: '', stderr: '' });
        when(mockContext.globalStorageUri).thenReturn(globalStorage);

        installer = new DeepnoteToolkitInstaller(
            instance(mockProcessServiceFactory),
            instance(mockOutputChannel),
            instance(mockContext),
            instance(mockFs)
        );
    });

    teardown(() => cts.dispose());

    test('installAdditionalPackages forwards the cancellation token to exec', async () => {
        seedInterpreterCache(venvPath);

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
            'the token must reach exec so Stop can kill pip'
        );
    });

    test('installAdditionalPackages does not call exec when no packages are requested', async () => {
        seedInterpreterCache(venvPath);

        await installer.installAdditionalPackages(venvPath, [], cts.token);

        verify(mockProcessService.exec(anything(), anything(), anything())).never();
    });

    test('installAdditionalPackages reports a killed pip install as cancelled', async () => {
        seedInterpreterCache(venvPath);
        killExecViaToken();

        assert.instanceOf(
            await rejection(installer.installAdditionalPackages(venvPath, ['some-package'], cts.token)),
            CancellationError,
            'pip killed mid-flight must not resolve as installed'
        );
        const [lastLine] = capture(mockOutputChannel.appendLine).last();
        assert.strictEqual(
            lastLine,
            'Package installation cancelled',
            'the output channel must not accuse a user-initiated Stop of being an install failure'
        );
    });

    test('ensureVenvAndToolkit forwards the cancellation token to the toolkit version probe', async () => {
        seedInterpreterCache(venvPath);
        when(mockProcessService.exec(anything(), anything(), anything())).thenResolve({
            stdout: '1.2.3\n',
            stderr: ''
        });
        // Kernel spec already present, so the fast path runs the probe exec and nothing else.
        when(mockFs.exists(anything())).thenResolve(true);

        const result = await installer.ensureVenvAndToolkit(venvInterpreter, venvPath, false, cts.token);

        assert.strictEqual(result.toolkitVersion, '1.2.3');
        verify(mockProcessService.exec(anything(), anything(), anything())).once();
        const [file, args, options] = capture(mockProcessService.exec).first();
        assert.deepStrictEqual(
            { file, args, options },
            {
                file: fakePython.fsPath,
                args: ['-c', 'import deepnote_toolkit; print(deepnote_toolkit.__version__)'],
                options: { throwOnStdErr: false, token: cts.token }
            },
            'the token must reach the isToolkitInstalled probe'
        );
    });

    test('an existing kernel spec is recognised by kernel.json, not by its directory', async () => {
        seedInterpreterCache(venvPath);
        when(mockProcessService.exec(anything(), anything(), anything())).thenResolve({
            stdout: '1.2.3\n',
            stderr: ''
        });
        when(mockFs.exists(anything())).thenResolve(true);

        await installer.ensureVenvAndToolkit(venvInterpreter, venvPath, false, cts.token);

        const [checkedPath] = capture(mockFs.exists).first();
        assert.strictEqual(
            checkedPath.fsPath,
            Uri.joinPath(venvPath, 'share', 'jupyter', 'kernels', 'deepnote-venv', 'kernel.json').fsPath,
            'a cancelled ipykernel install leaves the directory behind, so only kernel.json proves it finished'
        );
    });

    test('a cancelled version probe is not mistaken for a missing toolkit', async () => {
        seedInterpreterCache(venvPath);
        killExecViaToken();

        // managedVenv: false means a genuinely missing toolkit surfaces as DeepnoteToolkitMissingError.
        const error = await rejection(installer.ensureVenvAndToolkit(venvInterpreter, venvPath, false, cts.token));

        assert.notInstanceOf(error, DeepnoteToolkitMissingError, 'cancelling must not be read as "toolkit missing"');
        assert.instanceOf(error, CancellationError);
    });

    test('a cancelled kernel spec install does not resolve as a ready venv', async () => {
        seedInterpreterCache(venvPath);
        when(mockFs.exists(anything())).thenResolve(false);
        // Exec 0 is the version probe; the ipykernel install that follows it gets killed.
        let execCount = 0;
        when(mockProcessService.exec(anything(), anything(), anything())).thenCall(
            async (): Promise<ExecutionResult<string>> => {
                if (execCount++ === 0) {
                    return { stdout: '1.2.3\n', stderr: '' };
                }

                cts.cancel();

                return { stdout: '', stderr: '' };
            }
        );

        assert.instanceOf(
            await rejection(installer.ensureVenvAndToolkit(venvInterpreter, venvPath, false, cts.token)),
            CancellationError,
            'a half-written kernel spec must not be reported as a ready venv'
        );
    });

    test('cancelling a managed install rejects with CancellationError, not an install failure', async () => {
        when(mockFs.exists(anything())).thenResolve(false);
        // `python -m venv` is the first exec of a managed install.
        killExecViaToken();

        const error = await rejection(
            installer.ensureVenvAndToolkit(baseInterpreter, managedVenvPath, true, cts.token)
        );

        assert.notInstanceOf(
            error,
            DeepnoteToolkitInstallError,
            'wrapping cancellation pops the "install failed" UI instead of unwinding quietly'
        );
        assert.instanceOf(error, CancellationError);
    });

    test('every subprocess of a managed install carries the cancellation token', async () => {
        const execCalls: { file: string; options?: SpawnOptions }[] = [];
        when(mockFs.exists(anything())).thenResolve(false);
        when(mockProcessService.exec(anything(), anything(), anything())).thenCall(
            async (file: string, _args: string[], options?: SpawnOptions): Promise<ExecutionResult<string>> => {
                execCalls.push({ file, options });
                // The venv interpreter only becomes resolvable once `python -m venv` has run.
                seedInterpreterCache(managedVenvPath);

                return { stdout: file === fakePython.fsPath ? '1.2.3\n' : '', stderr: '' };
            }
        );

        await installer.ensureVenvAndToolkit(baseInterpreter, managedVenvPath, true, cts.token);

        assert.deepStrictEqual(
            execCalls.map(({ file }) => file),
            [
                baseInterpreter.uri.fsPath, // python -m venv
                fakePython.fsPath, // pip install --upgrade pip
                fakePython.fsPath, // pip install deepnote-toolkit ...
                fakePython.fsPath, // version probe
                fakePython.fsPath // ipykernel install
            ]
        );
        assert.deepStrictEqual(
            execCalls.filter(({ options }) => options?.token !== cts.token),
            [],
            'a subprocess without the token cannot be killed by Stop'
        );
    });
});
