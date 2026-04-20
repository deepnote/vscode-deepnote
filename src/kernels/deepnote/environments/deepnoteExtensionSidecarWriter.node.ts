import { inject, injectable } from 'inversify';
import { env, Uri, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { logger } from '../../../platform/logging';
import { IDeepnoteEnvironmentManager, IDeepnoteProjectEnvironmentMapper } from '../types';

const SIDECAR_FILENAME = 'deepnote.json';

/**
 * Returns the editor-specific settings folder name based on the current app.
 * - VS Code → `.vscode`
 * - Cursor  → `.cursor`
 * - Antigravity → `.antigravity`
 * - Unknown → `.vscode` (safe default)
 */
function getEditorSettingsFolder(): string {
    const appName = env.appName.toLowerCase();
    if (appName.includes('cursor')) {
        return '.cursor';
    }
    if (appName.includes('antigravity')) {
        return '.antigravity';
    }
    return '.vscode';
}

interface SidecarEntry {
    environmentId: string;
    venvPath: string;
    pythonInterpreter: string;
}

interface SidecarFile {
    mappings: Record<string, SidecarEntry>;
}

/**
 * Writes a `deepnote.json` sidecar file in the editor settings
 * folder (e.g. `.vscode/`, `.cursor/`, `.antigravity/`) so that external
 * tools (e.g. the Deepnote CLI) can discover the selected venv path for
 * each project without reading VS Code workspace state.
 */
@injectable()
export class DeepnoteExtensionSidecarWriter implements IExtensionSyncActivationService {
    /** Serializes sidecar writes to avoid read-modify-write races. */
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        @inject(IDeepnoteProjectEnvironmentMapper) private readonly mapper: IDeepnoteProjectEnvironmentMapper,
        @inject(IDeepnoteEnvironmentManager) private readonly environmentManager: IDeepnoteEnvironmentManager,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate(): void {
        this.disposables.push(
            this.mapper.onDidSetEnvironment((e) => this.handleSetEnvironment(e)),
            this.mapper.onDidRemoveEnvironment((e) => this.handleRemoveEnvironment(e)),
            this.environmentManager.onDidChangeEnvironments(() => this.handleEnvironmentsChanged())
        );

        // Sync existing mappings so the sidecar is up-to-date for existing users
        // who already have workspace-state mappings but no sidecar file yet.
        void this.syncExistingMappings();
    }

    private async handleEnvironmentsChanged(): Promise<void> {
        try {
            await this.enqueueWrite(async (sidecar) => {
                if (Object.keys(sidecar.mappings).length === 0) {
                    return false;
                }

                let changed = false;
                for (const [projectId, entry] of Object.entries(sidecar.mappings)) {
                    try {
                        const environment = this.environmentManager.getEnvironment(entry.environmentId);
                        if (!environment) {
                            delete sidecar.mappings[projectId];
                            changed = true;
                        } else if (
                            environment.venvPath.fsPath !== entry.venvPath ||
                            environment.pythonInterpreter.uri.fsPath !== entry.pythonInterpreter
                        ) {
                            sidecar.mappings[projectId] = {
                                environmentId: entry.environmentId,
                                venvPath: environment.venvPath.fsPath,
                                pythonInterpreter: environment.pythonInterpreter.uri.fsPath
                            };
                            changed = true;
                        }
                    } catch (entryError) {
                        logger.warn(`[SidecarWriter] Failed to process mapping for project ${projectId}`, entryError);
                    }
                }

                return changed;
            });
        } catch (error) {
            logger.warn('[SidecarWriter] Failed to handle environments changed', error);
        }
    }

    private async handleRemoveEnvironment({ projectId }: { projectId: string }): Promise<void> {
        try {
            await this.enqueueWrite(async (sidecar) => {
                if (!(projectId in sidecar.mappings)) {
                    return false;
                }
                delete sidecar.mappings[projectId];
                return true;
            });
        } catch (error) {
            logger.warn('[SidecarWriter] Failed to handle remove environment', error);
        }
    }

    private async handleSetEnvironment({
        projectId,
        environmentId
    }: {
        projectId: string;
        environmentId: string;
    }): Promise<void> {
        try {
            const environment = this.environmentManager.getEnvironment(environmentId);
            if (!environment) {
                return;
            }

            await this.enqueueWrite(async (sidecar) => {
                sidecar.mappings[projectId] = {
                    environmentId,
                    venvPath: environment.venvPath.fsPath,
                    pythonInterpreter: environment.pythonInterpreter.uri.fsPath
                };
                return true;
            });
        } catch (error) {
            logger.warn('[SidecarWriter] Failed to handle set environment', error);
        }
    }

    /**
     * On activation, iterate all persisted mapper entries and write their
     * mappings to the sidecar. Mappings are already keyed by project id from
     * the new mapper, so no per-file YAML reads are required here.
     */
    private async syncExistingMappings(): Promise<void> {
        try {
            await this.environmentManager.waitForInitialization();
            await this.mapper.waitForInitialization();

            const allMappings = this.mapper.getAllMappings();
            if (allMappings.size === 0) {
                return;
            }

            const entries: Array<{
                projectId: string;
                environmentId: string;
                venvPath: string;
                pythonInterpreter: string;
            }> = [];

            for (const [projectId, environmentId] of allMappings) {
                try {
                    const environment = this.environmentManager.getEnvironment(environmentId);
                    if (!environment) {
                        continue;
                    }

                    entries.push({
                        projectId,
                        environmentId,
                        venvPath: environment.venvPath.fsPath,
                        pythonInterpreter: environment.pythonInterpreter.uri.fsPath
                    });
                } catch (entryError) {
                    logger.warn(`[SidecarWriter] Failed to process mapping for project ${projectId}`, entryError);
                }
            }

            if (entries.length === 0) {
                return;
            }

            await this.enqueueWrite(async (sidecar) => {
                for (const entry of entries) {
                    sidecar.mappings[entry.projectId] = {
                        environmentId: entry.environmentId,
                        venvPath: entry.venvPath,
                        pythonInterpreter: entry.pythonInterpreter
                    };
                }
                return true;
            });
        } catch (error) {
            logger.warn('[SidecarWriter] Failed to sync existing mappings', error);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Serializes all sidecar mutations through a queue so that concurrent
     * read-modify-write cycles don't clobber each other. The `mutate` callback
     * receives the current sidecar contents and returns `true` if it modified
     * the object (i.e. should be written back).
     */
    private enqueueWrite(mutate: (sidecar: SidecarFile) => Promise<boolean>): Promise<void> {
        const op = this.writeQueue.then(async () => {
            const sidecar = await this.readSidecar();
            const changed = await mutate(sidecar);
            if (changed) {
                await this.writeSidecar(sidecar);
            }
        });
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- keep queue chain alive after rejection
        this.writeQueue = op.catch(() => {});
        return op;
    }

    private getSidecarUri(): Uri | undefined {
        const folder = workspace.workspaceFolders?.[0];
        if (!folder) {
            return undefined;
        }
        return Uri.joinPath(folder.uri, getEditorSettingsFolder(), SIDECAR_FILENAME);
    }

    private async readSidecar(): Promise<SidecarFile> {
        const uri = this.getSidecarUri();
        if (!uri) {
            return { mappings: {} };
        }

        try {
            const raw = await workspace.fs.readFile(uri);
            const parsed = JSON.parse(Buffer.from(raw).toString('utf-8')) as SidecarFile;
            if (parsed?.mappings && typeof parsed.mappings === 'object') {
                return parsed;
            }
        } catch {
            // File doesn't exist or is invalid — start fresh.
        }

        return { mappings: {} };
    }

    private async writeSidecar(sidecar: SidecarFile): Promise<void> {
        const uri = this.getSidecarUri();
        if (!uri) {
            return;
        }

        // Ensure the editor settings folder exists (e.g. .vscode/).
        const folderUri = Uri.joinPath(uri, '..');
        await workspace.fs.createDirectory(folderUri);

        const content = JSON.stringify(sidecar, undefined, 2) + '\n';
        await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
    }
}
