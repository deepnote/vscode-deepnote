import { inject, injectable } from 'inversify';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { Environment } from '@deepnote/blocks';

import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { computeHash } from '../../../platform/common/crypto';
import { raceTimeout } from '../../../platform/common/utils/async';
import { logger } from '../../../platform/logging';
import { parsePipFreezeFile } from './pipFileParser';
import { IDeepnoteEnvironmentManager, IDeepnoteNotebookEnvironmentMapper } from '../../../kernels/deepnote/types';
import { Uri } from 'vscode';
import { DeepnoteEnvironment } from '../../../kernels/deepnote/environments/deepnoteEnvironment';
import * as path from '../../../platform/vscode-path/path';

const captureTimeoutInMilliseconds = 5_000;

// Re-export for backward compatibility with existing tests
export { parsePipFreezeFile, parsePipFreezeFile as parsePipFreeze } from './pipFileParser';

export const IEnvironmentCapture = Symbol('IEnvironmentCapture');

export interface IEnvironmentCapture {
    /**
     * Capture environment metadata for a given interpreter.
     */
    captureEnvironment(notebookUri: Uri): Promise<Environment | undefined>;
}

type PythonEnvironmentType = 'uv' | 'conda' | 'venv' | 'poetry' | 'system';

@injectable()
export class EnvironmentCapture implements IEnvironmentCapture {
    constructor(
        @inject(IDeepnoteNotebookEnvironmentMapper)
        private readonly environmentMapper: IDeepnoteNotebookEnvironmentMapper,
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager
    ) {}

    async captureEnvironment(notebookUri: Uri): Promise<Environment | undefined> {
        const deepnoteEnvironment = this.getEnvironmentForNotebook(notebookUri);

        if (!deepnoteEnvironment) {
            logger.warn('[EnvironmentCapture] No Deepnote environment found for the given notebook');

            return undefined;
        }

        const interpreterPath = deepnoteEnvironment.pythonInterpreter.uri.fsPath;
        const pipDir = os.platform() === 'win32' ? 'Scripts' : 'bin';
        const pipBinary = os.platform() === 'win32' ? 'pip.exe' : 'pip';
        const pipBinaryPath = path.resolve(deepnoteEnvironment.venvPath.fsPath, pipDir, pipBinary);

        logger.info(`[EnvironmentCapture] Capturing environment for interpreter ${interpreterPath}`);

        const platform = `${os.platform()}-${os.arch()}`;

        const [pythonVersion, pythonEnvironment, packages] = await Promise.all([
            this.determinePythonVersion(deepnoteEnvironment.pythonInterpreter),
            this.determinePythonEnvironment(),
            this.listPackageVersions(pipBinaryPath)
        ]);

        if (!pythonVersion) {
            logger.warn('[EnvironmentCapture] Unable to determine Python version');

            return undefined;
        }

        logger.info(`[EnvironmentCapture] Determined Python version ${pythonVersion}.`);
        logger.info(`[EnvironmentCapture] Determined Python environment type ${pythonEnvironment}.`);
        logger.info('[EnvironmentCapture] Determined platform.', { platform });
        logger.info(`[EnvironmentCapture] Retrieved package versions for ${Object.keys(packages).length} packages.`);

        const hash = await this.computeHash(pythonVersion, pythonEnvironment, platform, packages);

        logger.info(`[EnvironmentCapture] Computed environment hash ${hash}.`);

        return {
            hash,
            packages,
            platform,
            python: {
                environment: pythonEnvironment,
                version: pythonVersion
            }
        };
    }

    private async computeHash(
        version: string,
        environment: string,
        platform: string,
        packages: Record<string, string>
    ): Promise<string> {
        const sortedPackageList = Object.keys(packages)
            .sort((a, b) => a.localeCompare(b))
            .map((pkg) => `${pkg}==${packages[pkg]}`)
            .join(',');

        const parts = [version, environment, platform, sortedPackageList];

        const hash = await computeHash(parts.join('|'), 'SHA-256');

        return `sha256:${hash}`;
    }

    private async determinePythonEnvironment(): Promise<PythonEnvironmentType> {
        // We manage the venv for the Environment that we use to run the Deepnote Kernel so this will always be executed in a
        // venv environment. Once we support other environment types, we can expand this logic.
        return 'venv';
    }

    private async determinePythonVersion(interpreter: PythonEnvironment): Promise<string | undefined> {
        const pythonVersionFromInterpreter = await this.determinePythonVersionFromRunningTheInterpreter(interpreter);

        if (pythonVersionFromInterpreter) {
            return pythonVersionFromInterpreter;
        }

        const pythonVersionFromPath = this.determinePythonVersionFromPath(interpreter);

        if (pythonVersionFromPath) {
            return pythonVersionFromPath;
        }

        return undefined;
    }

    private determinePythonVersionFromPath(interpreter: PythonEnvironment): string | undefined {
        const interpreterPath = interpreter.uri.fsPath;

        const patterns = [
            // python3.12, python3.12.exe
            /python(\d+\.\d+(?:\.\d+)?)/i,
            // pyenv: ~/.pyenv/versions/3.9.7/bin/python
            /versions\/(\d+\.\d+(?:\.\d+)?)\//,
            // uv: cpython-3.12.0-macos-aarch64-none
            /cpython-(\d+\.\d+(?:\.\d+)?)-/,
            // Windows: Python312 or Python3.12
            /Python(\d)(\d+)(?![.\d])/i
        ];

        for (const pattern of patterns) {
            const match = interpreterPath.match(pattern);

            if (match) {
                // Handle Windows "Python312" format
                if (match[2] !== undefined) {
                    return `${match[1]}.${match[2]}`;
                }

                return match[1];
            }
        }

        return undefined;
    }

    private async determinePythonVersionFromRunningTheInterpreter(
        interpreter: PythonEnvironment
    ): Promise<string | undefined> {
        const execFileAsync = promisify(execFile);

        const getVersion = async (): Promise<string | undefined> => {
            try {
                // Returns the version string, e.g., "Python 3.12.0\n"
                const { stdout } = await execFileAsync(interpreter.uri.fsPath, ['--version']);

                logger.info('[EnvironmentCapture] Raw version info output', { output: stdout });

                const version = stdout.trim().split(' ')[1];

                return version;
            } catch (error) {
                logger.error('[EnvironmentCapture] Failed to determine Python version from interpreter', error);

                return undefined;
            }
        };

        return raceTimeout(captureTimeoutInMilliseconds, undefined, getVersion());
    }

    private getEnvironmentForNotebook(notebookUri: Uri): DeepnoteEnvironment | undefined {
        const environmentId = this.environmentMapper.getEnvironmentForNotebook(notebookUri);

        if (!environmentId) {
            return undefined;
        }

        return this.environmentManager.getEnvironment(environmentId);
    }

    private async listPackageVersions(pipBinaryPath: string): Promise<Record<string, string>> {
        const execFileAsync = promisify(execFile);

        const getPackages = async (): Promise<Record<string, string>> => {
            try {
                const output = await execFileAsync(pipBinaryPath, ['freeze', '--local']);

                if (output.stderr) {
                    logger.warn('pip freeze returned error output', { stderr: output.stderr });
                }

                if (output.stdout) {
                    return parsePipFreezeFile(output.stdout);
                }

                logger.warn('pip freeze returned empty output');

                return {};
            } catch (error) {
                logger.error('Failed to get packages via pip freeze', error);

                return {};
            }
        };

        return raceTimeout(captureTimeoutInMilliseconds, {}, getPackages());
    }
}
