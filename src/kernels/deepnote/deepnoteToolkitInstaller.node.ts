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

    public async getVenvInterpreter(deepnoteFileUri: Uri): Promise<PythonEnvironment | undefined> {
        const venvPath = this.getVenvPath(deepnoteFileUri);
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

    public async ensureInstalled(
        baseInterpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        token?: CancellationToken
    ): Promise<PythonEnvironment | undefined> {
        const venvPath = this.getVenvPath(deepnoteFileUri);
        const venvKey = venvPath.fsPath;

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
        const existingVenv = await this.getVenvInterpreter(deepnoteFileUri);
        if (existingVenv && (await this.isToolkitInstalled(existingVenv))) {
            logger.info(`deepnote-toolkit venv already exists and is ready for ${deepnoteFileUri.fsPath}`);
            return existingVenv;
        }

        // Double-check for race condition: another caller might have started installation
        // while we were checking the venv
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
        const installation = this.installImpl(baseInterpreter, deepnoteFileUri, venvPath, token);
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

    private async installImpl(
        baseInterpreter: PythonEnvironment,
        deepnoteFileUri: Uri,
        venvPath: Uri,
        token?: CancellationToken
    ): Promise<PythonEnvironment | undefined> {
        try {
            Cancellation.throwIfCanceled(token);

            logger.info(`Creating virtual environment at ${venvPath.fsPath} for ${deepnoteFileUri.fsPath}`);
            this.outputChannel.appendLine(`Setting up Deepnote toolkit environment for ${deepnoteFileUri.fsPath}...`);

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
            const venvInterpreter = await this.getVenvInterpreter(deepnoteFileUri);
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
                logger.info('Installing kernel spec for venv...');
                try {
                    // Reuse the process service with system environment
                    await venvProcessService.exec(
                        venvInterpreter.uri.fsPath,
                        [
                            '-m',
                            'ipykernel',
                            'install',
                            '--user',
                            '--name',
                            `deepnote-venv-${this.getVenvHash(deepnoteFileUri)}`,
                            '--display-name',
                            `Deepnote (${this.getDisplayName(deepnoteFileUri)})`
                        ],
                        { throwOnStdErr: false }
                    );
                    logger.info('Kernel spec installed successfully');
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

    private getDisplayName(deepnoteFileUri: Uri): string {
        // Get a friendly display name from the file path
        const parts = deepnoteFileUri.fsPath.split('/');
        return parts[parts.length - 1] || 'notebook';
    }
}
