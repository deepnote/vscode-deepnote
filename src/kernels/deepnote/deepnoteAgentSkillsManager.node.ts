import { inject, injectable } from 'inversify';
import { env, workspace } from 'vscode';

import { IProcessServiceFactory } from '../../platform/common/process/types.node';
import { EXTENSION_ROOT_DIR } from '../../platform/constants.node';
import { logger } from '../../platform/logging';
import { PythonEnvironment } from '../../platform/pythonEnvironments/info';
import * as path from '../../platform/vscode-path/path';

/**
 * The Deepnote CLI, bundled into the extension at build time (`buildDeepnoteCli` in
 * `build/esbuild/build.ts`) together with the skill files it installs. Nothing is fetched or
 * pip-installed at run time, so the CLI version is the one pinned in `package.json`.
 */
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

/**
 * Manages background installation of Deepnote agent skill files.
 *
 * Once a kernel starts on an interpreter, this service runs the bundled CLI's `install-skills` for
 * the editor's agent, once per interpreter per session, without blocking the server start. The CLI
 * runs on the editor's own Node (`process.execPath` as Node), never on the user's Python: the
 * previous `pip install --upgrade deepnote-cli` into the selected interpreter installed a 100 MB
 * wheel nobody consented to, and failed silently on externally managed Pythons (PEP 668).
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
    public ensureSkillsUpdated(environmentId: string, interpreter: PythonEnvironment): void {
        if (this.processedEnvironments.has(environmentId)) {
            return;
        }

        this.processedEnvironments.add(environmentId);

        this.updateSkillsInBackground(interpreter).catch((err) =>
            logger.warn('Failed to install Deepnote agent skills', err)
        );
    }

    private async updateSkillsInBackground(interpreter: PythonEnvironment): Promise<void> {
        const agentName = getAgentName();
        const workspaceRoot = workspace.workspaceFolders?.[0]?.uri;

        if (!workspaceRoot) {
            logger.info('No workspace folder open, skipping agent skills installation');

            return;
        }

        const processService = await this.processServiceFactory.create(undefined);

        logger.info(`Running deepnote install-skills --agent "${agentName}" in ${workspaceRoot.fsPath}`);

        // `process.execPath` is the editor's Electron binary; ELECTRON_RUN_AS_NODE makes it plain Node.
        // DEEPNOTE_PYTHON is how the CLI is told which interpreter a project runs on (it also reads
        // the `.vscode/deepnote.json` sidecar); set it on every CLI spawn so the two never disagree.
        const result = await processService.exec(
            process.execPath,
            [BUNDLED_CLI_PATH, 'install-skills', '--agent', agentName],
            {
                cwd: workspaceRoot.fsPath,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEEPNOTE_PYTHON: interpreter.uri.fsPath },
                throwOnStdErr: false
            }
        );

        if (result.stdout) {
            logger.info('install-skills output:', result.stdout);
        }
        if (result.stderr) {
            logger.warn('install-skills stderr:', result.stderr);
        }
    }
}
