import { inject, injectable } from 'inversify';
import { NotebookDocument, RelativePattern, Uri, workspace } from 'vscode';
import { DEFAULT_ENV_FILE, DEFAULT_INTEGRATIONS_FILE } from '@deepnote/database-integrations';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';
import { logger } from '../../../platform/logging';
import { DEEPNOTE_NOTEBOOK_TYPE } from '../../../kernels/deepnote/types';
import { IIntegrationEnvLiveRefresher } from './types';

/** Trailing-edge debounce so a burst of edits (e.g. .env and .deepnote.env.yaml both saved) is handled once. */
const debounceTimeInMilliseconds = 500;

const watchedEnvFileNames = [DEFAULT_INTEGRATIONS_FILE, DEFAULT_ENV_FILE];

/** Watches `.deepnote.env.yaml` / `.env` and live-refreshes affected notebooks' kernels on change (no restart). */
@injectable()
export class IntegrationsEnvFileWatcher implements IExtensionSyncActivationService {
    private readonly changedDirs = new Set<string>();
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly watchedDirs = new Set<string>();

    constructor(
        @inject(IIntegrationEnvLiveRefresher) private readonly liveRefresher: IIntegrationEnvLiveRefresher,
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
    public async handleChangedDirs(changedDirs: Set<string>): Promise<void> {
        const affected = this.findAffectedNotebooks(changedDirs);
        if (affected.length === 0) {
            return;
        }

        await this.liveRefresher.refresh(affected);
    }

    private findAffectedNotebooks(changedDirs: Set<string>): NotebookDocument[] {
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

            const deepnoteDir = Uri.joinPath(deepnoteFileUri, '..').fsPath;
            const workspaceRoot = workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath;

            if (changedDirs.has(deepnoteDir) || (workspaceRoot != null && changedDirs.has(workspaceRoot))) {
                affected.push(notebook);
            }
        }

        return affected;
    }

    private onFileEvent(dir: Uri): void {
        this.changedDirs.add(dir.fsPath);

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            const dirs = new Set(this.changedDirs);
            this.changedDirs.clear();
            this.handleChangedDirs(dirs).catch((error) =>
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
                watcher.onDidChange(() => this.onFileEvent(dir)),
                watcher.onDidCreate(() => this.onFileEvent(dir)),
                watcher.onDidDelete(() => this.onFileEvent(dir))
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
