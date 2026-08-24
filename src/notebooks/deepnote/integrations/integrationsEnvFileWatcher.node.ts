import { inject, injectable } from 'inversify';
import { NotebookDocument, RelativePattern, Uri, workspace } from 'vscode';
import { DEFAULT_ENV_FILE, DEFAULT_INTEGRATIONS_FILE } from '@deepnote/database-integrations';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IFileSystem } from '../../../platform/common/platform/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';
import {
    INTEGRATIONS_ENV_FILE_SETTING,
    isIntegrationsEnvFileEnabled
} from '../../../platform/notebooks/deepnote/integrationsEnvFileSettings';
import { logger } from '../../../platform/logging';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/constants';
import { IIntegrationEnvLiveRefresher } from './types';

/** Trailing-edge debounce so a burst of edits (e.g. .env and .deepnote.env.yaml both saved) is handled once. */
export const debounceTimeInMilliseconds = 500;

const watchedEnvFileNames = [DEFAULT_INTEGRATIONS_FILE, DEFAULT_ENV_FILE];

/** Watches `.deepnote.env.yaml` / `.env` and live-refreshes affected notebooks' kernels on change (no restart). */
@injectable()
export class IntegrationsEnvFileWatcher implements IExtensionSyncActivationService {
    /** Changed file names per directory: the YAML's own events must not be gated on the file still existing. */
    private readonly changedFilesByDir = new Map<string, Set<string>>();
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly watchedDirs = new Set<string>();

    constructor(
        @inject(IIntegrationEnvLiveRefresher) private readonly liveRefresher: IIntegrationEnvLiveRefresher,
        @inject(IFileSystem) private readonly fileSystem: IFileSystem,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate(): void {
        for (const folder of workspace.workspaceFolders ?? []) {
            this.watchDir(folder.uri);
        }

        for (const notebook of workspace.notebookDocuments) {
            this.watchNotebookDir(notebook);
        }

        this.disposables.push(
            workspace.onDidOpenNotebookDocument((notebook) => this.watchNotebookDir(notebook)),
            workspace.onDidChangeWorkspaceFolders((event) => {
                for (const folder of event.added) {
                    this.watchDir(folder.uri);
                }
            }),
            workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(INTEGRATIONS_ENV_FILE_SETTING)) {
                    this.refreshAllDeepnoteNotebooks();
                }
            }),
            {
                dispose: () => {
                    if (this.debounceTimer) {
                        clearTimeout(this.debounceTimer);
                        this.debounceTimer = undefined;
                    }
                }
            }
        );
    }

    private async findAffectedNotebooks(changedFilesByDir: Map<string, Set<string>>): Promise<NotebookDocument[]> {
        const affected: NotebookDocument[] = [];

        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
                continue;
            }

            const deepnoteFileUri = notebookPathToDeepnoteProjectFilePath(notebook.uri);

            // Same gate as IntegrationsFileConfigProvider: a disabled feature must not trigger kernel refreshes.
            if (!isIntegrationsEnvFileEnabled(deepnoteFileUri)) {
                continue;
            }

            const deepnoteDir = Uri.joinPath(deepnoteFileUri, '..');
            const workspaceRoot = workspace.getWorkspaceFolder(notebook.uri)?.uri;
            const candidateDirs =
                workspaceRoot != null && workspaceRoot.fsPath !== deepnoteDir.fsPath
                    ? [deepnoteDir, workspaceRoot]
                    : [deepnoteDir];

            const changedFiles = new Set(
                candidateDirs.flatMap((dir) => [...(changedFilesByDir.get(dir.fsPath) ?? [])])
            );
            if (changedFiles.size === 0) {
                continue;
            }

            // The YAML's own events are Deepnote-specific by construction, and its deletion is precisely when the
            // kernel must drop the variables it set — so it must not be gated on the file still existing. Only an
            // unrelated `.env` (a very common non-Deepnote file) needs the probe before hidden kernel executions.
            if (changedFiles.has(DEFAULT_INTEGRATIONS_FILE) || (await this.hasIntegrationsFile(candidateDirs))) {
                affected.push(notebook);
            }
        }

        return affected;
    }

    private async handleChangedDirs(changedFilesByDir: Map<string, Set<string>>): Promise<void> {
        const affected = await this.findAffectedNotebooks(changedFilesByDir);
        if (affected.length === 0) {
            return;
        }

        await this.liveRefresher.refresh(affected, 'env_file');
    }

    /** True when a `.deepnote.env.yaml` exists in any candidate dir (dir-then-root), mirroring the config provider's probe. */
    private async hasIntegrationsFile(dirs: Uri[]): Promise<boolean> {
        for (const dir of dirs) {
            const candidate = Uri.joinPath(dir, DEFAULT_INTEGRATIONS_FILE);
            if (await this.fileSystem.exists(candidate)) {
                return true;
            }
        }

        return false;
    }

    private onFileEvent(dir: Uri, fileName: string): void {
        const changed = this.changedFilesByDir.get(dir.fsPath) ?? new Set<string>();
        changed.add(fileName);
        this.changedFilesByDir.set(dir.fsPath, changed);

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            const changes = new Map(this.changedFilesByDir);
            this.changedFilesByDir.clear();
            this.handleChangedDirs(changes).catch((error) =>
                logger.error('IntegrationsEnvFileWatcher: Failed to handle env file change', error)
            );
        }, debounceTimeInMilliseconds);
    }

    /**
     * The gate itself changed, so findAffectedNotebooks cannot be reused: on disable its per-notebook check would
     * filter out exactly the kernels still holding file-sourced credentials.
     */
    private refreshAllDeepnoteNotebooks(): void {
        const notebooks = workspace.notebookDocuments.filter(
            (notebook) => notebook.notebookType === DEEPNOTE_NOTEBOOK_TYPE
        );
        if (notebooks.length === 0) {
            return;
        }

        this.liveRefresher
            .refresh(notebooks, 'env_file')
            .catch((error) =>
                logger.error('IntegrationsEnvFileWatcher: Failed to refresh after envFile setting change', error)
            );
    }

    private watchDir(dir: Uri): void {
        const dirPath = dir.fsPath;
        if (this.watchedDirs.has(dirPath)) {
            return;
        }
        this.watchedDirs.add(dirPath);

        for (const fileName of watchedEnvFileNames) {
            const pattern = new RelativePattern(dir, fileName);
            const watcher = workspace.createFileSystemWatcher(pattern, false, false, false);

            this.disposables.push(
                watcher,
                watcher.onDidChange(() => this.onFileEvent(dir, fileName)),
                watcher.onDidCreate(() => this.onFileEvent(dir, fileName)),
                watcher.onDidDelete(() => this.onFileEvent(dir, fileName))
            );
        }
    }

    private watchNotebookDir(notebook: NotebookDocument): void {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const deepnoteDir = Uri.joinPath(notebookPathToDeepnoteProjectFilePath(notebook.uri), '..');
        this.watchDir(deepnoteDir);
    }
}
