// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { CancellationToken, Uri, workspace } from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IDeepnoteToolkitInstaller, DEEPNOTE_TOOLKIT_WHEEL_URL } from './types';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { IOutputChannel, IExtensionContext } from '../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { IFileSystem } from '../../platform/common/platform/types';
import { Cancellation } from '../../platform/common/cancellation';

/**
 * Handles installation of the deepnote-toolkit Python package.
 */
@injectable()
export class DeepnoteToolkitInstaller implements IDeepnoteToolkitInstaller {
    private readonly venvPythonPaths: Map<string, Uri> = new Map();
    // Track in-flight installations per venv path to prevent concurrent installs
    private readonly pendingInstallations: Map<string, Promise<PythonEnvironment | undefined>> = new Map();

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(IFileSystem) private readonly fs: IFileSystem
    ) {}

    private getVenvPath(deepnoteFileUri: Uri): Uri {
        // Create a unique venv name based on the file path using a hash
        // This avoids Windows MAX_PATH issues and prevents directory structure leakage
        const hash = this.getVenvHash(deepnoteFileUri);
        return Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', hash);
    }

    /**
     * Get the venv Python interpreter by direct venv path.
     */
    private async getVenvInterpreterByPath(venvPath: Uri): Promise<PythonEnvironment | undefined> {
        const cacheKey = venvPath.fsPath;

        if (this.venvPythonPaths.has(cacheKey)) {
            return { uri: this.venvPythonPaths.get(cacheKey)!, id: this.venvPythonPaths.get(cacheKey)!.fsPath };
        }

        // Check if venv exists
        const pythonInVenv =
            process.platform === 'win32'
                ? Uri.joinPath(venvPath, 'Scripts', 'python.exe')
                : Uri.joinPath(venvPath, 'bin', 'python');

        if (await this.fs.exists(pythonInVenv)) {
            this.venvPythonPaths.set(cacheKey, pythonInVenv);
            return { uri: pythonInVenv, id: pythonInVenv.fsPath };
        }

        return undefined;
    }

    public async getVenvInterpreter(deepnoteFileUri: Uri): Promise<PythonEnvironment | undefined> {
        const venvPath = this.getVenvPath(deepnoteFileUri);
        return this.getVenvInterpreterByPath(venvPath);
    }

    /**
     * Environment-based method: Ensure venv and toolkit are installed at a specific path.
     * @param baseInterpreter The base Python interpreter to use for creating the venv
     * @param venvPath The exact path where the venv should be created
     * @param token Cancellation token
     * @returns The venv Python interpreter if successful
     */
    public async ensureVenvAndToolkit(
        baseInterpreter: PythonEnvironment,
        venvPath: Uri,
        token?: CancellationToken
    ): Promise<PythonEnvironment | undefined> {
        const venvKey = venvPath.fsPath;

        logger.info(`Ensuring virtual environment at ${venvKey}`);

        // Wait for any pending installation for this venv to complete
        const pendingInstall = this.pendingInstallations.get(venvKey);
        if (pendingInstall) {
            logger.info(`Waiting for pending installation for ${venvKey} to complete...`);
            try {
                return await pendingInstall;
            } catch {
                // If the previous installation failed, continue to retry
                logger.info(`Previous installation for ${venvKey} failed, retrying...`);
            }
        }

        // Check if venv already exists with toolkit installed
        const existingVenv = await this.getVenvInterpreterByPath(venvPath);
        if (existingVenv && (await this.isToolkitInstalled(existingVenv))) {
            logger.info(`deepnote-toolkit venv already exists and is ready at ${venvPath.fsPath}`);
            return existingVenv;
        }

        // Double-check for race condition
        const pendingAfterCheck = this.pendingInstallations.get(venvKey);
        if (pendingAfterCheck) {
            logger.info(`Another installation started for ${venvKey} while checking, waiting for it...`);
            try {
                return await pendingAfterCheck;
            } catch {
                logger.info(`Concurrent installation for ${venvKey} failed, retrying...`);
            }
        }

        // Start the installation and track it
        const installation = this.installVenvAndToolkit(baseInterpreter, venvPath, token);
        this.pendingInstallations.set(venvKey, installation);

        try {
            const result = await installation;
            return result;
        } finally {
            // Remove from pending installations when done
            if (this.pendingInstallations.get(venvKey) === installation) {
                this.pendingInstallations.delete(venvKey);
            }
        }
    }

    /**
     * Install additional packages in an existing venv.
     * @param venvPath Path to the venv
     * @param packages List of package names to install
     * @param token Cancellation token
     */
    public async installAdditionalPackages(
        venvPath: Uri,
        packages: string[],
        token?: CancellationToken
    ): Promise<void> {
        if (!packages || packages.length === 0) {
            return;
        }

        const venvInterpreter = await this.getVenvInterpreterByPath(venvPath);
        if (!venvInterpreter) {
            throw new Error(`Venv not found at ${venvPath.fsPath}`);
        }

        logger.info(`Installing additional packages in ${venvPath.fsPath}: ${packages.join(', ')}`);
        this.outputChannel.appendLine(`Installing packages: ${packages.join(', ')}...`);

        try {
            Cancellation.throwIfCanceled(token);

            const venvProcessService = await this.processServiceFactory.create(undefined);
            const installResult = await venvProcessService.exec(
                venvInterpreter.uri.fsPath,
                ['-m', 'pip', 'install', '--upgrade', ...packages],
                { throwOnStdErr: false }
            );

            if (installResult.stdout) {
                this.outputChannel.appendLine(installResult.stdout);
            }
            if (installResult.stderr) {
                this.outputChannel.appendLine(installResult.stderr);
            }

            logger.info('Additional packages installed successfully');
            this.outputChannel.appendLine('✓ Packages installed successfully');
        } catch (ex) {
            logger.error(`Failed to install additional packages: ${ex}`);
            this.outputChannel.appendLine(`✗ Failed to install packages: ${ex}`);
            throw ex;
        }
    }

    /**
     * Legacy file-based method (for backward compatibility).
     * @deprecated Use ensureVenvAndToolkit instead
     */
    public async ensureInstalled(
        baseInterpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<PythonEnvironment | undefined> {
        const venvPath = this.getVenvPath(deepnoteFileUri);
        return this.ensureVenvAndToolkit(baseInterpreter, venvPath, token);
    }

    /**
     * Install venv and toolkit at a specific path (environment-based).
     */
    private async installVenvAndToolkit(
        baseInterpreter: PythonEnvironment,
        venvPath: Uri,
        token?: CancellationToken
    ): Promise<PythonEnvironment | undefined> {
        try {
            Cancellation.throwIfCanceled(token);

            logger.info(`Creating virtual environment at ${venvPath.fsPath}`);
            this.outputChannel.appendLine(`Setting up Deepnote toolkit environment...`);

            // Create venv parent directory if it doesn't exist
            const venvParentDir = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs');
            await this.fs.createDirectory(venvParentDir);

            // Remove old venv if it exists but is broken
            if (await this.fs.exists(venvPath)) {
                logger.info('Removing existing broken venv');
                await workspace.fs.delete(venvPath, { recursive: true });
            }

            // Create new venv
            // Use undefined as resource to get full system environment
            const processService = await this.processServiceFactory.create(undefined);
            const venvResult = await processService.exec(baseInterpreter.uri.fsPath, ['-m', 'venv', venvPath.fsPath], {
                throwOnStdErr: false
            });

            // Log any stderr output (warnings, etc.) but don't fail on it
            if (venvResult.stderr) {
                logger.info(`venv creation stderr: ${venvResult.stderr}`);
            }

            Cancellation.throwIfCanceled(token);

            // Verify venv was created successfully by checking for the Python interpreter
            const venvInterpreter = await this.getVenvInterpreterByPath(venvPath);
            if (!venvInterpreter) {
                logger.error('Failed to create venv: Python interpreter not found after venv creation');
                if (venvResult.stderr) {
                    logger.error(`venv stderr: ${venvResult.stderr}`);
                }
                this.outputChannel.appendLine('Error: Failed to create virtual environment');
                return undefined;
            }

            // Use undefined as resource to get full system environment (including git in PATH)
            const venvProcessService = await this.processServiceFactory.create(undefined);

            // Upgrade pip in the venv to the latest version
            logger.info('Upgrading pip in venv to latest version...');
            this.outputChannel.appendLine('Upgrading pip...');
            const pipUpgradeResult = await venvProcessService.exec(
                venvInterpreter.uri.fsPath,
                ['-m', 'pip', 'install', '--upgrade', 'pip'],
                { throwOnStdErr: false }
            );

            if (pipUpgradeResult.stdout) {
                logger.info(`pip upgrade output: ${pipUpgradeResult.stdout}`);
            }
            if (pipUpgradeResult.stderr) {
                logger.info(`pip upgrade stderr: ${pipUpgradeResult.stderr}`);
            }

            Cancellation.throwIfCanceled(token);

            // Install deepnote-toolkit and ipykernel in venv
            logger.info(`Installing deepnote-toolkit and ipykernel in venv from ${DEEPNOTE_TOOLKIT_WHEEL_URL}`);
            this.outputChannel.appendLine('Installing deepnote-toolkit and ipykernel...');

            const installResult = await venvProcessService.exec(
                venvInterpreter.uri.fsPath,
                [
                    '-m',
                    'pip',
                    'install',
                    '--upgrade',
                    `deepnote-toolkit[server] @ ${DEEPNOTE_TOOLKIT_WHEEL_URL}`,
                    'ipykernel'
                ],
                { throwOnStdErr: false }
            );

            Cancellation.throwIfCanceled(token);

            if (installResult.stdout) {
                this.outputChannel.appendLine(installResult.stdout);
            }
            if (installResult.stderr) {
                this.outputChannel.appendLine(installResult.stderr);
            }

            // Verify installation
            if (await this.isToolkitInstalled(venvInterpreter)) {
                logger.info('deepnote-toolkit installed successfully in venv');

                // Install kernel spec so the kernel uses this venv's Python
                // Install into the venv itself (not --user) so the Deepnote server can discover it
                logger.info('Installing kernel spec for venv...');
                try {
                    const kernelSpecName = this.getKernelSpecName(venvPath);
                    const kernelDisplayName = this.getKernelDisplayName(venvPath);

                    // Reuse the process service with system environment
                    await venvProcessService.exec(
                        venvInterpreter.uri.fsPath,
                        [
                            '-m',
                            'ipykernel',
                            'install',
                            '--prefix',
                            venvPath.fsPath,
                            '--name',
                            kernelSpecName,
                            '--display-name',
                            kernelDisplayName
                        ],
                        { throwOnStdErr: false }
                    );
                    const kernelSpecPath = Uri.joinPath(venvPath, 'share', 'jupyter', 'kernels', kernelSpecName);
                    logger.info(`Kernel spec installed successfully to ${kernelSpecPath.fsPath}`);
                } catch (ex) {
                    logger.warn(`Failed to install kernel spec: ${ex}`);
                    // Don't fail the entire installation if kernel spec creation fails
                }

                this.outputChannel.appendLine('✓ Deepnote toolkit ready');
                return venvInterpreter;
            } else {
                logger.error('deepnote-toolkit installation failed');
                this.outputChannel.appendLine('✗ deepnote-toolkit installation failed');
                return undefined;
            }
        } catch (ex) {
            logger.error(`Failed to set up deepnote-toolkit: ${ex}`);
            this.outputChannel.appendLine(`Error setting up deepnote-toolkit: ${ex}`);
            return undefined;
        }
    }

    private async isToolkitInstalled(interpreter: PythonEnvironment): Promise<boolean> {
        try {
            // Use undefined as resource to get full system environment
            const processService = await this.processServiceFactory.create(undefined);
            const result = await processService.exec(interpreter.uri.fsPath, [
                '-c',
                "import deepnote_toolkit; print('installed')"
            ]);
            return result.stdout.toLowerCase().includes('installed');
        } catch (ex) {
            logger.debug(`deepnote-toolkit not found: ${ex}`);
            return false;
        }
    }

    /**
     * Generate a kernel spec name from a venv path.
     * This is used for both file-based and environment-based venvs.
     */
    private getKernelSpecName(venvPath: Uri): string {
        // Extract the venv directory name (last segment of path)
        const venvDirName = venvPath.fsPath.split(/[/\\]/).filter(Boolean).pop() || 'venv';
        return `deepnote-${venvDirName}`;
    }

    /**
     * Generate a display name from a venv path.
     */
    private getKernelDisplayName(venvPath: Uri): string {
        const venvDirName = venvPath.fsPath.split(/[/\\]/).filter(Boolean).pop() || 'venv';
        return `Deepnote (${venvDirName})`;
    }

    public getVenvHash(deepnoteFileUri: Uri): string {
        // Create a short hash from the file path for kernel naming and venv directory
        // This provides better uniqueness and prevents directory structure leakage
        const path = deepnoteFileUri.fsPath;

        // Use a simple hash function for better distribution
        let hash = 0;
        for (let i = 0; i < path.length; i++) {
            const char = path.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32-bit integer
        }

        // Convert to positive hex string and limit length
        const hashStr = Math.abs(hash).toString(16);
        return `venv_${hashStr}`.substring(0, 16);
    }
}
