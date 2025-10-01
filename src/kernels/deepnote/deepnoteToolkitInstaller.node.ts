// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IDeepnoteToolkitInstaller, DEEPNOTE_TOOLKIT_WHEEL_URL } from './types';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { IOutputChannel, IExtensionContext } from '../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { IFileSystem } from '../../platform/common/platform/types';

/**
 * Handles installation of the deepnote-toolkit Python package.
 */
@injectable()
export class DeepnoteToolkitInstaller implements IDeepnoteToolkitInstaller {
    private readonly venvPythonPaths: Map<string, Uri> = new Map();

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(IFileSystem) private readonly fs: IFileSystem
    ) {}

    private getVenvPath(deepnoteFileUri: Uri): Uri {
        // Create a unique venv name based on the file path
        // Use a simple hash approach - replace special chars with underscores
        const safePath = deepnoteFileUri.fsPath.replace(/[^a-zA-Z0-9]/g, '_');
        return Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs', safePath);
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
        deepnoteFileUri: Uri
    ): Promise<PythonEnvironment | undefined> {
        const venvPath = this.getVenvPath(deepnoteFileUri);

        try {
            // Check if venv already exists with toolkit installed
            const existingVenv = await this.getVenvInterpreter(deepnoteFileUri);
            if (existingVenv && (await this.isToolkitInstalled(existingVenv))) {
                logger.info(`deepnote-toolkit venv already exists and is ready for ${deepnoteFileUri.fsPath}`);
                return existingVenv;
            }

            logger.info(`Creating virtual environment at ${venvPath.fsPath} for ${deepnoteFileUri.fsPath}`);
            this.outputChannel.appendLine(`Setting up Deepnote toolkit environment for ${deepnoteFileUri.fsPath}...`);

            // Create venv parent directory if it doesn't exist
            const venvParentDir = Uri.joinPath(this.context.globalStorageUri, 'deepnote-venvs');
            await this.fs.createDirectory(venvParentDir);

            // Remove old venv if it exists but is broken
            if (await this.fs.exists(venvPath)) {
                logger.info('Removing existing broken venv');
                await this.fs.delete(venvPath);
            }

            // Create new venv
            const processService = await this.processServiceFactory.create(baseInterpreter.uri);
            const venvResult = await processService.exec(baseInterpreter.uri.fsPath, ['-m', 'venv', venvPath.fsPath], {
                throwOnStdErr: false
            });

            if (venvResult.stderr && !venvResult.stderr.includes('WARNING')) {
                logger.error(`Failed to create venv: ${venvResult.stderr}`);
                this.outputChannel.appendLine(`Error creating venv: ${venvResult.stderr}`);
                return undefined;
            }

            // Get venv Python interpreter
            const venvInterpreter = await this.getVenvInterpreter(deepnoteFileUri);
            if (!venvInterpreter) {
                logger.error('Failed to locate venv Python interpreter');
                return undefined;
            }

            // Install deepnote-toolkit in venv
            logger.info(`Installing deepnote-toolkit in venv from ${DEEPNOTE_TOOLKIT_WHEEL_URL}`);
            this.outputChannel.appendLine('Installing deepnote-toolkit...');

            const venvProcessService = await this.processServiceFactory.create(venvInterpreter.uri);
            const installResult = await venvProcessService.exec(
                venvInterpreter.uri.fsPath,
                ['-m', 'pip', 'install', '--upgrade', `deepnote-toolkit[server] @ ${DEEPNOTE_TOOLKIT_WHEEL_URL}`],
                { throwOnStdErr: false }
            );

            if (installResult.stdout) {
                this.outputChannel.appendLine(installResult.stdout);
            }
            if (installResult.stderr) {
                this.outputChannel.appendLine(installResult.stderr);
            }

            // Verify installation
            if (await this.isToolkitInstalled(venvInterpreter)) {
                logger.info('deepnote-toolkit installed successfully in venv');
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
            const processService = await this.processServiceFactory.create(interpreter.uri);
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
}
