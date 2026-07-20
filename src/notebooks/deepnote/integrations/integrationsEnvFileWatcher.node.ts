import { inject, injectable } from 'inversify';
import { NotebookDocument, RelativePattern, Uri, workspace } from 'vscode';
import { DEFAULT_ENV_FILE, DEFAULT_INTEGRATIONS_FILE } from '@deepnote/database-integrations';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IFileSystem } from '../../../platform/common/platform/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';
import { logger } from '../../../platform/logging';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IIntegrationEnvLiveRefresher } from './types';

/** Trailing-edge debounce so a burst of edits (e.g. .env and .deepnote.env.yaml both saved) is handled once. */
const debounceTimeInMilliseconds = 500;

const watchedEnvFileNames = [DEFAULT_INTEGRATIONS_FILE, DEFAULT_ENV_FILE];

/**
 * Watches `.deepnote.env.yaml` / `.env` and live-refreshes affected notebooks' kernels on change (no restart).
 * Deleting `.deepnote.env.yaml` refreshes too, so the credentials it contributed are unset rather than left live.
 */
@injectable()
export class IntegrationsEnvFileWatcher implements IExtensionSyncActivationService {
    private readonly changedDirs = new Set<string>();
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Subset of {@link changedDirs} where `.deepnote.env.yaml` itself was created, changed or deleted. */
    private readonly integrationsFileChangedDirs = new Set<string>();
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

    /** Public so it can be unit-tested without real filesystem events. */
    public async handleChangedDirs(
        changedDirs: Set<string>,
        integrationsFileChangedDirs: Set<string> = new Set()
    ): Promise<void> {
        const affected = await this.findAffectedNotebooks(changedDirs, integrationsFileChangedDirs);
        if (affected.length === 0) {
            return;
        }

        await this.liveRefresher.refresh(affected);
    }

    private async findAffectedNotebooks(
        changedDirs: Set<string>,
        integrationsFileChangedDirs: Set<string>
    ): Promise<NotebookDocument[]> {
        const affected: NotebookDocument[] = [];

        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
                continue;
            }

            const deepnoteFileUri = notebookPathToDeepnoteProjectFilePath(notebook.uri);

            // Mirror IntegrationsFileConfigProvider's gate: a disabled feature must not trigger kernel refreshes.
            const enabled = workspace
                .getConfiguration('deepnote', deepnoteFileUri)
                .get<boolean>('integrations.envFile.enabled', true);
            if (enabled === false) {
                continue;
            }

            const deepnoteDir = Uri.joinPath(deepnoteFileUri, '..');
            const workspaceRoot = workspace.getWorkspaceFolder(notebook.uri)?.uri;

            const changedInScope =
                changedDirs.has(deepnoteDir.fsPath) || (workspaceRoot != null && changedDirs.has(workspaceRoot.fsPath));
            if (!changedInScope) {
                continue;
            }

            // An event on `.deepnote.env.yaml` itself is unambiguously ours and always refreshes, without
            // consulting the filesystem. Requiring the file to exist would skip exactly the deletion case —
            // the variables it contributed would stay live in the kernel, and deleting the file is the most
            // direct way a user revokes them.
            const integrationsFileChanged =
                integrationsFileChangedDirs.has(deepnoteDir.fsPath) ||
                (workspaceRoot != null && integrationsFileChangedDirs.has(workspaceRoot.fsPath));

            // A `.env` change, by contrast, only affects integration env when a `.deepnote.env.yaml` actually
            // exists for this notebook; without one the refresh is a no-op and its status message misleading,
            // so an unrelated `.env` (a very common non-Deepnote file) must not trigger hidden kernel
            // executions (F2).
            const candidateDirs =
                workspaceRoot != null && workspaceRoot.fsPath !== deepnoteDir.fsPath
                    ? [deepnoteDir, workspaceRoot]
                    : [deepnoteDir];
            if (integrationsFileChanged || (await this.hasIntegrationsFile(candidateDirs))) {
                affected.push(notebook);
            }
        }

        return affected;
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
        this.changedDirs.add(dir.fsPath);

        if (fileName === DEFAULT_INTEGRATIONS_FILE) {
            this.integrationsFileChangedDirs.add(dir.fsPath);
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            const dirs = new Set(this.changedDirs);
            const integrationsFileDirs = new Set(this.integrationsFileChangedDirs);
            this.changedDirs.clear();
            this.integrationsFileChangedDirs.clear();
            this.handleChangedDirs(dirs, integrationsFileDirs).catch((error) =>
                logger.error('IntegrationsEnvFileWatcher: Failed to handle env file change', error)
            );
        }, debounceTimeInMilliseconds);
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
