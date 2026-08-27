import { inject, injectable } from 'inversify';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { Environment } from '@deepnote/blocks';

import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { computeHash } from '../../../platform/common/crypto';
import { raceTimeout } from '../../../platform/common/utils/async';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import { getEnvironmentType } from '../../../platform/interpreter/helpers';
import { EnvironmentType } from '../../../platform/pythonEnvironments/info';
import { logger } from '../../../platform/logging';
import { parsePipFreezeFile } from './pipFileParser';
import { Uri } from 'vscode';

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

// The snapshot schema names a narrower set than the Python extension discovers; anything without a
// counterpart is reported as the plain interpreter it effectively is.
const ENVIRONMENT_TYPES: Partial<Record<EnvironmentType, PythonEnvironmentType>> = {
    [EnvironmentType.Conda]: 'conda',
    [EnvironmentType.Poetry]: 'poetry',
    [EnvironmentType.Venv]: 'venv',
    [EnvironmentType.VirtualEnv]: 'venv',
    [EnvironmentType.VirtualEnvWrapper]: 'venv'
};

@injectable()
export class EnvironmentCapture implements IEnvironmentCapture {
    constructor(@inject(IInterpreterService) private readonly interpreterService: IInterpreterService) {}

    async captureEnvironment(notebookUri: Uri): Promise<Environment | undefined> {
        const interpreter = await this.interpreterService.getActiveInterpreter(notebookUri);

        if (!interpreter) {
            logger.warn('[EnvironmentCapture] No active Python interpreter for the given notebook');

            return undefined;
        }

        logger.info(`[EnvironmentCapture] Capturing environment for interpreter ${interpreter.uri.fsPath}`);

        const platform = `${os.platform()}-${os.arch()}`;

        const [pythonVersion, pythonEnvironment, packages] = await Promise.all([
            this.determinePythonVersion(interpreter),
            this.determinePythonEnvironment(interpreter),
            this.listPackageVersions(interpreter)
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

    protected determinePythonEnvironment(interpreter: PythonEnvironment): PythonEnvironmentType {
        return ENVIRONMENT_TYPES[getEnvironmentType(interpreter)] ?? 'system';
    }

    protected async determinePythonVersion(interpreter: PythonEnvironment): Promise<string | undefined> {
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

    // `-m pip` rather than a `<venv>/bin/pip` path: the active interpreter may be conda, system or
    // poetry, where no such binary exists next to it.
    protected async listPackageVersions(interpreter: PythonEnvironment): Promise<Record<string, string>> {
        const execFileAsync = promisify(execFile);

        const getPackages = async (): Promise<Record<string, string>> => {
            try {
                const output = await execFileAsync(interpreter.uri.fsPath, ['-m', 'pip', 'freeze', '--local']);

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
