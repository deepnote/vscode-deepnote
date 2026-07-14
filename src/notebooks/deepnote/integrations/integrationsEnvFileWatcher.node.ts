import { inject, injectable } from 'inversify';
import { NotebookDocument, ProgressLocation, RelativePattern, Uri, l10n, window, workspace } from 'vscode';
import { DEFAULT_ENV_FILE, DEFAULT_INTEGRATIONS_FILE } from '@deepnote/database-integrations';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IDisposableRegistry } from '../../../platform/common/types';
import { DataScience } from '../../../platform/common/utils/localize';
import { notebookPathToDeepnoteProjectFilePath } from '../../../platform/deepnote/deepnoteProjectUtils';
import { logger } from '../../../platform/logging';
import { DEEPNOTE_NOTEBOOK_TYPE, IDeepnoteKernelAutoSelector } from '../../../kernels/deepnote/types';
import { IKernelProvider } from '../../../kernels/types';

/** Trailing-edge debounce so a burst of edits (e.g. .env and .deepnote.env.yaml both saved) is handled once. */
const debounceTimeInMilliseconds = 500;

/** Integration env files whose changes require respawning the toolkit server. */
const watchedEnvFileNames = [DEFAULT_INTEGRATIONS_FILE, DEFAULT_ENV_FILE];

/**
 * Watches the integration env files (`.deepnote.env.yaml` / `.env`) next to open Deepnote notebooks and in
 * workspace-folder roots. When one changes and a running kernel is affected, it prompts to restart the
 * toolkit server so the new values are picked up — the server captures its environment at spawn, so a plain
 * kernel.restart() is insufficient (see {@link IDeepnoteKernelAutoSelector.restartServerForNotebook}).
 *
 * Node-only sibling of IntegrationKernelRestartHandler / FederatedAuthKernelRestartBridge. Unlike those, it
 * does not gate on SQL cells: an env change can affect any cell.
 */
@injectable()
export class IntegrationsEnvFileWatcher implements IExtensionSyncActivationService {
    /** Dirs (fsPath) that saw an env-file event during the current debounce window. */
    private readonly changedDirs = new Set<string>();
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private isRestarting = false;
    /** Monotonic sequence so a newer change supersedes a still-open prompt. */
    private promptSeq = 0;
    /** Dirs (fsPath) already covered by a watcher, to avoid duplicate watchers. */
    private readonly watchedDirs = new Set<string>();

    constructor(
        @inject(IDeepnoteKernelAutoSelector) private readonly kernelAutoSelector: IDeepnoteKernelAutoSelector,
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
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
     * Core decision logic, called on the debounce trailing edge. Public so it can be unit-tested without
     * real filesystem events: find affected running kernels, prompt once, and restart on confirmation.
     */
    public async handleChangedDirs(changedDirs: Set<string>): Promise<void> {
        // A restart is already running; its fresh respawn will read the latest config, and a second prompt
        // would stack. Skip.
        if (this.isRestarting) {
            logger.debug('IntegrationsEnvFileWatcher: Restart already in progress, ignoring env file change');

            return;
        }

        const affectedNotebooks = this.findAffectedNotebooks(changedDirs);

        // No affected running kernel: the loader is stateless, so the next start reads fresh config anyway.
        if (affectedNotebooks.length === 0) {
            logger.info('IntegrationsEnvFileWatcher: No affected running kernels, no restart prompt needed');

            return;
        }

        // Capture the sequence before showing the prompt so a newer change can supersede this one.
        const seq = ++this.promptSeq;

        const selection = await window.showInformationMessage(
            l10n.t('Integration environment file changed. Restart to apply the new values?'),
            DataScience.restartKernelMessageYes
        );

        if (selection !== DataScience.restartKernelMessageYes) {
            return;
        }

        // A newer env-file change opened a newer prompt while this one was pending; let the newer one win.
        if (seq !== this.promptSeq) {
            logger.info('IntegrationsEnvFileWatcher: Env file prompt superseded by a newer change, skipping restart');

            return;
        }

        if (this.isRestarting) {
            return;
        }

        await this.restartNotebooks(affectedNotebooks);
    }

    /**
     * Resolve the open Deepnote notebooks with a started kernel whose .deepnote dir OR workspace-folder root
     * (dir-then-root) saw a change, deduped to one representative notebook per unique .deepnote server.
     */
    private findAffectedNotebooks(changedDirs: Set<string>): NotebookDocument[] {
        const byServer = new Map<string, NotebookDocument>();

        for (const notebook of workspace.notebookDocuments) {
            if (notebook.notebookType !== DEEPNOTE_NOTEBOOK_TYPE) {
                continue;
            }

            const kernel = this.kernelProvider.get(notebook);
            if (!kernel || !kernel.startedAtLeastOnce) {
                continue;
            }

            const deepnoteFileUri = notebookPathToDeepnoteProjectFilePath(notebook.uri);
            const deepnoteDir = Uri.joinPath(deepnoteFileUri, '..').fsPath;
            const workspaceRoot = workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath;

            const affected = changedDirs.has(deepnoteDir) || (workspaceRoot != null && changedDirs.has(workspaceRoot));
            if (!affected) {
                continue;
            }

            // One toolkit server is shared across a .deepnote file's notebook views — dedup by its fsPath.
            const serverKey = deepnoteFileUri.fsPath;
            if (!byServer.has(serverKey)) {
                byServer.set(serverKey, notebook);
            }
        }

        return [...byServer.values()];
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

    /** Respawn the toolkit server for each affected notebook, guarded by isRestarting and per-notebook try/catch. */
    private async restartNotebooks(notebooks: NotebookDocument[]): Promise<void> {
        this.isRestarting = true;

        try {
            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: l10n.t('Restarting Deepnote server...'),
                    cancellable: true
                },
                async (_progress, token) => {
                    for (const notebook of notebooks) {
                        try {
                            await this.kernelAutoSelector.restartServerForNotebook(notebook, token);
                        } catch (error) {
                            logger.error(
                                `IntegrationsEnvFileWatcher: Failed to restart server for ${notebook.uri.toString()}`,
                                error
                            );
                        }
                    }
                }
            );
        } finally {
            this.isRestarting = false;
        }
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
