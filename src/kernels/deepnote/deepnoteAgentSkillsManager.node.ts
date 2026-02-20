import { inject, injectable } from 'inversify';
import { env, workspace } from 'vscode';

import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import * as path from '../../platform/vscode-path/path';

/**
 * Returns the Deepnote CLI `--agent` value for the current editor,
 * or `undefined` if the editor is not recognized.
 */
function getAgentName(): string | undefined {
    const appName = env.appName.toLowerCase();

    if (appName.includes('cursor')) {
        return 'cursor';
    }
    if (appName.includes('windsurf')) {
        return 'windsurf';
    }

    // VS Code and unknown editors default to GitHub Copilot
    return 'github copilot';
}

/**
 * Manages background installation of Deepnote agent skill files.
 *
 * After each environment's venv becomes ready (toolkit installed), this
 * service upgrades `deepnote-cli` and runs `deepnote install-skills`
 * once per session per environment, without blocking the server start.
 */
@injectable()
export class DeepnoteAgentSkillsManager {
    private readonly processedEnvironments = new Set<string>();

    constructor(@inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory) {}

    /**
     * Fire-and-forget: ensures the agent skill files are up-to-date for the
     * given environment. Safe to call repeatedly -- only the first call per
     * environment per session actually does work.
     */
    public ensureSkillsUpdated(environmentId: string, venvInterpreter: PythonEnvironment): void {
        if (this.processedEnvironments.has(environmentId)) {
            return;
        }

        this.processedEnvironments.add(environmentId);

        this.updateSkillsInBackground(venvInterpreter).catch((err) =>
            logger.warn('Failed to install Deepnote agent skills', err)
        );
    }

    private async updateSkillsInBackground(venvInterpreter: PythonEnvironment): Promise<void> {
        const agentName = getAgentName();
        if (!agentName) {
            return;
        }

        const workspaceRoot = workspace.workspaceFolders?.[0]?.uri;
        if (!workspaceRoot) {
            logger.info('No workspace folder open, skipping agent skills installation');
            return;
        }

        const processService = await this.processServiceFactory.create(undefined);
        const venvBinDir = path.dirname(venvInterpreter.uri.fsPath);

        // Upgrade deepnote-cli to latest (also installs it if missing in older venvs)
        logger.info('Upgrading deepnote-cli in venv...');
        const upgradeResult = await processService.exec(
            venvInterpreter.uri.fsPath,
            ['-m', 'pip', 'install', '--upgrade', 'deepnote-cli'],
            { throwOnStdErr: false }
        );

        if (upgradeResult.stderr) {
            logger.info('deepnote-cli upgrade stderr:', upgradeResult.stderr);
        }

        // Run install-skills using the venv's deepnote entry point
        const deepnoteBin = path.join(venvBinDir, 'deepnote');
        logger.info(`Running deepnote install-skills --agent "${agentName}" in ${workspaceRoot.fsPath}`);

        const installResult = await processService.exec(deepnoteBin, ['install-skills', '--agent', agentName], {
            cwd: workspaceRoot.fsPath,
            throwOnStdErr: false
        });

        if (installResult.stdout) {
            logger.info('install-skills output:', installResult.stdout);
        }
        if (installResult.stderr) {
            logger.warn('install-skills stderr:', installResult.stderr);
        }
    }
}
