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

/** Integration env files whose changes trigger a live env refresh. */
const watchedEnvFileNames = [DEFAULT_INTEGRATIONS_FILE, DEFAULT_ENV_FILE];

/**
 * Watches the integration env files (`.deepnote.env.yaml` / `.env`) next to open Deepnote notebooks and in
 * workspace-folder roots. When one changes, it live-refreshes the integration environment in the affected
 * notebooks' kernels (via {@link IIntegrationEnvLiveRefresher}) so the new values are picked up without a restart.
 *
 * Node-only sibling of IntegrationEnvRefreshHandler / FederatedAuthKernelRestartBridge. Unlike those, it
 * does not gate on SQL cells: an env change can affect any cell.
 */
@injectable()
export class IntegrationsEnvFileWatcher implements IExtensionSyncActivationService {
    /** Dirs (fsPath) that saw an env-file event during the current debounce window. */
    private readonly changedDirs = new Set<string>();
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Dirs (fsPath) already covered by a watcher, to avoid duplicate watchers. */
    private readonly watchedDirs = new Set<string>();

    constructor(
        @inject(IIntegrationEnvLiveRefresher) private readonly liveRefresher: IIntegrationEnvLiveRefresher,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate(): void {
        // Cover every workspace-folder root (dir-then-root fallback) ...
        for (const folder of workspace.workspaceFolders ?? []) {
            this.watchDir(folder.uri);
        }

        // ... and the .deepnote dir of every already-open notebook.
        for (const notebook of workspace.notebookDocuments) {
            this.watchNotebookDir(notebook);
        }

        // Add watchers for notebooks opened later and for folders added to the workspace.
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

    /**
     * Core decision logic, called on the debounce trailing edge. Public so it can be unit-tested without real
     * filesystem events.
     */
    public async handleChangedDirs(changedDirs: Set<string>): Promise<void> {
        const affected = this.findAffectedNotebooks(changedDirs);
        if (affected.length === 0) {
            return;
        }

        await this.liveRefresher.refresh(affected);
    }

    /** Open Deepnote notebooks whose .deepnote dir OR workspace-folder root (dir-then-root) saw a change. */
    private findAffectedNotebooks(changedDirs: Set<string>): NotebookDocument[] {
        const affected: NotebookDocument[] = [];

        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
                continue;
            }

            const deepnoteFileUri = notebookPathToDeepnoteProjectFilePath(notebook.uri);
            const deepnoteDir = Uri.joinPath(deepnoteFileUri, '..').fsPath;
            const workspaceRoot = workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath;

            if (changedDirs.has(deepnoteDir) || (workspaceRoot != null && changedDirs.has(workspaceRoot))) {
                affected.push(notebook);
            }
        }

        return affected;
    }

    /** File-watcher callback: accumulate the changed dir and (re)arm the debounce timer. */
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

    /** Create change/create/delete watchers for the env files in a dir, deduped by dir fsPath. */
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

    /** Watch the .deepnote dir of a Deepnote notebook (no-op for other notebook types). */
    private watchNotebookDir(notebook: NotebookDocument): void {
        if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
            return;
        }

        const deepnoteDir = Uri.joinPath(notebookPathToDeepnoteProjectFilePath(notebook.uri), '..');
        this.watchDir(deepnoteDir);
    }
}
