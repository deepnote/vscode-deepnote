// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { CancellationToken, l10n, Uri } from 'vscode';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { IOutputChannel, IExtensionContext } from '../../platform/common/types';
import { STANDARD_OUTPUT_CHANNEL } from '../../platform/common/constants';
import { IFileSystem } from '../../platform/common/platform/types';
import { Cancellation } from '../../platform/common/cancellation';
import { DEEPNOTE_TOOLKIT_WHEEL_URL, DEEPNOTE_TOOLKIT_VERSION } from './types';

/**
 * Manages a shared installation of deepnote-toolkit in a versioned extension directory.
 * This avoids installing the heavy wheel package in every virtual environment.
 */
@injectable()
export class DeepnoteSharedToolkitInstaller {
    private readonly sharedInstallationPath: Uri;
    private readonly versionFilePath: Uri;
    private readonly toolkitVersion: string;
    private installationPromise: Promise<boolean> | undefined;

    constructor(
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private readonly outputChannel: IOutputChannel,
        @inject(IExtensionContext) private readonly context: IExtensionContext,
        @inject(IFileSystem) private readonly fs: IFileSystem
    ) {
        // Create versioned directory for shared toolkit installation
        this.toolkitVersion = DEEPNOTE_TOOLKIT_VERSION;
        this.sharedInstallationPath = Uri.joinPath(
            this.context.globalStorageUri,
            'deepnote-shared-toolkit',
            this.toolkitVersion
        );
        this.versionFilePath = Uri.joinPath(this.sharedInstallationPath, 'version.txt');
    }

    /**
     * Ensures the shared deepnote-toolkit installation is available.
     * @param baseInterpreter The base Python interpreter to use for installation
     * @param token Cancellation token
     * @returns True if installation is ready, false if failed
     */
    public async ensureSharedInstallation(
        baseInterpreter: PythonEnvironment,
        token?: CancellationToken
    ): Promise<boolean> {
        // Check if already installed and up to date
        if (await this.isInstalled()) {
            logger.info(`Shared deepnote-toolkit v${this.toolkitVersion} is already installed`);
            return true;
        }

        // Prevent concurrent installations
        if (this.installationPromise) {
            logger.info('Waiting for existing shared toolkit installation to complete...');
            return await this.installationPromise;
        }

        this.installationPromise = this.installSharedToolkit(baseInterpreter, token);
        try {
            const result = await this.installationPromise;
            return result;
        } finally {
            this.installationPromise = undefined;
        }
    }

    /**
     * Gets the path to the shared toolkit installation.
     */
    public getSharedInstallationPath(): Uri {
        return this.sharedInstallationPath;
    }

    /**
     * Tests if the shared installation can be imported by a Python interpreter.
     * Useful for debugging import issues.
     */
    public async testSharedInstallation(interpreter: PythonEnvironment): Promise<boolean> {
        try {
            const processService = await this.processServiceFactory.create(interpreter.uri);

            // Test import with explicit path
            const result = await processService.exec(
                interpreter.uri.fsPath,
                [
                    '-c',
                    `import sys; sys.path.insert(0, '${this.sharedInstallationPath.fsPath}'); import deepnote_toolkit; print('shared import successful')`
                ],
                { throwOnStdErr: false }
            );

            const success = result.stdout.toLowerCase().includes('shared import successful');
            logger.info(`Shared installation test result: ${success ? 'SUCCESS' : 'FAILED'}`);
            if (!success) {
                logger.warn(`Shared installation test failed: stdout=${result.stdout}, stderr=${result.stderr}`);
            }
            return success;
        } catch (ex) {
            logger.error(`Shared installation test error: ${ex}`);
            return false;
        }
    }

    /**
     * Creates a .pth file in the given venv that points to the shared toolkit installation.
     * @param venvInterpreter The venv Python interpreter
     * @param token Cancellation token
     */
    public async createPthFile(venvInterpreter: PythonEnvironment, token?: CancellationToken): Promise<void> {
        Cancellation.throwIfCanceled(token);

        // Ensure shared installation is available first
        const isInstalled = await this.ensureSharedInstallation(venvInterpreter, token);
        if (!isInstalled) {
            throw new Error('Failed to ensure shared deepnote-toolkit installation');
        }

        // Find the correct site-packages directory by querying Python
        const processService = await this.processServiceFactory.create(venvInterpreter.uri);
        const sitePackagesResult = await processService.exec(
            venvInterpreter.uri.fsPath,
            ['-c', 'import site; print(site.getsitepackages()[0])'],
            { throwOnStdErr: false }
        );

        if (!sitePackagesResult.stdout) {
            throw new Error('Failed to determine site-packages directory');
        }

        const sitePackagesPath = Uri.file(sitePackagesResult.stdout.trim());

        // Create site-packages directory if it doesn't exist
        if (!(await this.fs.exists(sitePackagesPath))) {
            await this.fs.createDirectory(sitePackagesPath);
        }

        // Create .pth file pointing to shared installation
        const pthFilePath = Uri.joinPath(sitePackagesPath, 'deepnote-toolkit.pth');
        const pthContent = `${this.sharedInstallationPath.fsPath}\n`;

        await this.fs.writeFile(pthFilePath, Buffer.from(pthContent, 'utf8'));
        logger.info(
            `Created .pth file at ${pthFilePath.fsPath} pointing to shared installation ${this.sharedInstallationPath.fsPath}`
        );

        // Verify the .pth file is working by testing import
        const testResult = await processService.exec(
            venvInterpreter.uri.fsPath,
            ['-c', 'import sys; print("\\n".join(sys.path))'],
            { throwOnStdErr: false }
        );
        logger.info(`Python sys.path after .pth file creation: ${testResult.stdout}`);
    }

    /**
     * Checks if the shared installation exists and is up to date.
     */
    private async isInstalled(): Promise<boolean> {
        try {
            // Check if version file exists and matches current version
            if (!(await this.fs.exists(this.versionFilePath))) {
                return false;
            }

            const versionContent = await this.fs.readFile(this.versionFilePath);
            const installedVersion = versionContent.toString().trim();

            if (installedVersion !== this.toolkitVersion) {
                logger.info(`Version mismatch: installed=${installedVersion}, expected=${this.toolkitVersion}`);
                return false;
            }

            // Check if the actual package is installed
            const packagePath = Uri.joinPath(this.sharedInstallationPath, 'deepnote_toolkit');
            return await this.fs.exists(packagePath);
        } catch (ex) {
            logger.debug(`Error checking shared installation: ${ex}`);
            return false;
        }
    }

    /**
     * Installs the shared toolkit in the versioned directory.
     */
    private async installSharedToolkit(
        baseInterpreter: PythonEnvironment,
        token?: CancellationToken
    ): Promise<boolean> {
        try {
            Cancellation.throwIfCanceled(token);

            logger.info(
                `Installing shared deepnote-toolkit v${this.toolkitVersion} to ${this.sharedInstallationPath.fsPath}`
            );
            this.outputChannel.appendLine(l10n.t('Installing shared deepnote-toolkit v{0}...', this.toolkitVersion));

            // Create shared installation directory
            await this.fs.createDirectory(this.sharedInstallationPath);

            // Remove existing installation if it exists
            const existingPackage = Uri.joinPath(this.sharedInstallationPath, 'deepnote_toolkit');
            if (await this.fs.exists(existingPackage)) {
                await this.fs.delete(existingPackage);
            }

            // Install deepnote-toolkit to the shared directory
            const processService = await this.processServiceFactory.create(baseInterpreter.uri);
            const installResult = await processService.exec(
                baseInterpreter.uri.fsPath,
                [
                    '-m',
                    'pip',
                    'install',
                    '--target',
                    this.sharedInstallationPath.fsPath,
                    '--upgrade',
                    `deepnote-toolkit[server] @ ${DEEPNOTE_TOOLKIT_WHEEL_URL}`
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
            if (await this.fs.exists(existingPackage)) {
                // Write version file
                await this.fs.writeFile(this.versionFilePath, Buffer.from(this.toolkitVersion, 'utf8'));

                logger.info(`Shared deepnote-toolkit v${this.toolkitVersion} installed successfully`);
                this.outputChannel.appendLine(l10n.t('✓ Shared deepnote-toolkit v{0} ready', this.toolkitVersion));
                return true;
            } else {
                logger.error('Shared deepnote-toolkit installation failed - package not found');
                this.outputChannel.appendLine(l10n.t('✗ Shared deepnote-toolkit installation failed'));
                return false;
            }
        } catch (ex) {
            logger.error(`Failed to install shared deepnote-toolkit: ${ex}`);
            this.outputChannel.appendLine(l10n.t('Error installing shared deepnote-toolkit: {0}', ex));
            return false;
        }
    }
}
