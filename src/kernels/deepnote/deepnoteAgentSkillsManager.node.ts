import { inject, injectable } from 'inversify';
import { env, workspace } from 'vscode';

import { pathExists } from '../../platform/common/platform/fileUtils.node';
import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { EXTENSION_ROOT_DIR } from '../../platform/constants.node';
import { logger } from '../../platform/logging';
import * as path from '../../platform/vscode-path/path';

/** Produced at build time by `buildDeepnoteCli` in `build/esbuild/build.ts`. */
export const BUNDLED_CLI_PATH = path.join(EXTENSION_ROOT_DIR, 'dist', 'deepnoteCli.cjs');

/**
 * Returns the Deepnote CLI `--agent` value for the current editor.
 * Defaults to 'github copilot' for unrecognized editors.
 */
function getAgentName(): string {
    const appName = env.appName.toLowerCase();

    if (appName.includes('cursor')) {
        return 'cursor';
    }
    if (appName.includes('windsurf')) {
        return 'windsurf';
    }
    if (appName.includes('antigravity')) {
        return 'antigravity';
    }

    // VS Code and unknown editors default to GitHub Copilot
    return 'github copilot';
}

/** Manages background installation of Deepnote agent skill files. */
@injectable()
export class DeepnoteAgentSkillsManager {
    private readonly processedInterpreters = new Set<string>();

    constructor(@inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory) {}

    /**
     * Fire-and-forget: ensures the agent skill files are up-to-date for the
     * given interpreter. Safe to call repeatedly -- only the first call per
     * interpreter per session actually does work.
     */
    public async ensureSkillsUpdated(interpreterId: string): Promise<void> {
        if (this.processedInterpreters.has(interpreterId)) {
            return;
        }

        this.processedInterpreters.add(interpreterId);

        await this.updateSkillsInBackground().catch((err) =>
            logger.warn('Failed to install Deepnote agent skills', err)
        );
    }

    private async updateSkillsInBackground(): Promise<void> {
        const agentName = getAgentName();
        const workspaceRoot = workspace.workspaceFolders?.[0]?.uri;

        if (!workspaceRoot) {
            logger.info('No workspace folder open, skipping agent skills installation');

            return;
        }

        if (!(await pathExists(BUNDLED_CLI_PATH))) {
            logger.warn(`Deepnote CLI bundle is missing at ${BUNDLED_CLI_PATH}, skipping agent skills installation`);

            return;
        }

        const processService = await this.processServiceFactory.create(undefined);

        logger.info(`Running deepnote install-skills --agent "${agentName}" in ${workspaceRoot.fsPath}`);

        // `process.execPath` is the editor's Electron binary; ELECTRON_RUN_AS_NODE makes it plain Node.
        const installResult = await processService.exec(
            process.execPath,
            [BUNDLED_CLI_PATH, 'install-skills', '--agent', agentName],
            {
                cwd: workspaceRoot.fsPath,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                throwOnStdErr: false
            }
        );

        if (installResult.stdout) {
            logger.info('install-skills output:', installResult.stdout);
        }
        if (installResult.stderr) {
            logger.warn('install-skills stderr:', installResult.stderr);
        }
    }
}
