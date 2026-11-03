import {
    findSyncManifestRoot,
    hasSyncManifest,
    SYNC_MANIFEST_FILENAME,
    syncWorkspace,
    type ProjectSyncOutcome,
    type SyncConflict,
    type SyncConflictDecision,
    type SyncEvent,
    type WorkspaceSyncOptions,
    type WorkspaceSyncResult
} from '@deepnote/cloud-sync';
import { inject, injectable } from 'inversify';
import {
    commands,
    MessageItem,
    NotebookDocument,
    ProgressLocation,
    QuickPickItem,
    RelativePattern,
    Uri,
    window,
    workspace
} from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { Commands } from '../../../platform/common/constants';
import { getFilePath } from '../../../platform/common/platform/fs-paths';
import { IExtensionContext } from '../../../platform/common/types';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { dirname, isEqual } from '../../../platform/vscode-path/resources';
import { getApiEndpoint } from '../importClient.node';
import { showCloudError } from './cloudErrors.node';
import { IDeepnoteApiTokenService } from './types';

interface RootPickItem extends QuickPickItem {
    root?: Uri;
}

function label(uri: Uri): string {
    return workspace.asRelativePath(uri);
}

function unsavedDeepnoteNotebooks(): NotebookDocument[] {
    return workspace.notebookDocuments.filter((notebook) => notebook.notebookType === 'deepnote' && notebook.isDirty);
}

function logSyncEvent(event: SyncEvent): void {
    switch (event.kind) {
        case 'project-outcome': {
            const { action, path, detail } = event.outcome;
            logger.info(detail ? `${action} ${path} — ${detail}` : `${action} ${path}`);

            return;
        }
        case 'warning':
            logger.warn(event.message);

            return;
        default:
            logger.debug('Deepnote Cloud sync event', event);
    }
}

async function askOverride(question: string, overrideLabel: string): Promise<SyncConflictDecision> {
    const override: MessageItem = { title: overrideLabel };
    const choice = await window.showWarningMessage<MessageItem>(question, { modal: true }, override, {
        title: DeepnoteCloud.skip,
        isCloseAffordance: true
    });

    return choice === override ? 'override' : 'skip';
}

@injectable()
export class SyncWithDeepnoteCloudCommandHandler implements IExtensionSyncActivationService {
    private syncInProgress = false;

    constructor(
        @inject(IDeepnoteApiTokenService) private readonly apiTokenService: IDeepnoteApiTokenService,
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext
    ) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.SyncWithDeepnoteCloud, () => this.syncWithDeepnoteCloud())
        );
    }

    /** Seam for tests, which never reach the network. */
    protected runSyncWorkspace(options: WorkspaceSyncOptions): Promise<WorkspaceSyncResult> {
        return syncWorkspace(options);
    }

    private askConflict(conflict: SyncConflict): Promise<SyncConflictDecision> {
        switch (conflict.kind) {
            case 'cloud-changed-after-local-edit':
                return askOverride(
                    DeepnoteCloud.conflictCloudChangedAfterLocalEdit(conflict.projectName),
                    DeepnoteCloud.conflictCloudChangedAfterLocalEditOverride
                );
            case 'changed-on-both-sides':
                return askOverride(
                    DeepnoteCloud.conflictChangedOnBothSides(conflict.projectName),
                    DeepnoteCloud.conflictChangedOnBothSidesOverride
                );
            case 'untracked-local-directory':
                return askOverride(
                    DeepnoteCloud.conflictUntrackedLocalDirectory(conflict.projectName, conflict.projectDir),
                    DeepnoteCloud.conflictUntrackedLocalDirectoryOverride
                );
            // Only `deleteMissingNotebooks` and `allFiles` produce these, and this command sets neither.
            case 'empty-local-directory':
            case 'working-files-changed':
                logger.warn(`Skipped an unexpected ${conflict.kind} conflict for "${conflict.projectName}"`);

                return Promise.resolve('skip');
        }
    }

    private async chooseRoot(): Promise<Uri | undefined> {
        const roots = (await workspace.findFiles(`**/${SYNC_MANIFEST_FILENAME}`, '**/node_modules/**'))
            .map((manifest) => dirname(manifest))
            .sort((a, b) => label(a).localeCompare(label(b)));

        if (roots.length > 0) {
            const items: RootPickItem[] = [
                ...roots.map((root) => ({ label: label(root), root })),
                { label: DeepnoteCloud.chooseAnotherSyncFolder }
            ];
            const picked = await window.showQuickPick(items, { placeHolder: DeepnoteCloud.chooseSyncFolder });
            if (!picked) {
                return undefined;
            }
            if (picked.root) {
                return picked.root;
            }
        }

        const folder = (
            await window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: workspace.workspaceFolders?.[0]?.uri,
                title: DeepnoteCloud.chooseSyncFolderTitle,
                openLabel: DeepnoteCloud.chooseSyncFolderOpenLabel
            })
        )?.[0];
        if (!folder) {
            return undefined;
        }

        const root = await findSyncManifestRoot(getFilePath(folder));

        return root ? Uri.file(root) : folder;
    }

    private async chooseSyncTarget(): Promise<{ root: Uri; isFirstSync: boolean } | undefined> {
        const root = await this.chooseRoot();
        if (!root) {
            return undefined;
        }

        if (!workspace.getWorkspaceFolder(root)) {
            void window.showWarningMessage(DeepnoteCloud.syncFolderOutsideWorkspace(getFilePath(root)));

            return undefined;
        }

        const overlapping = await this.findOverlappingRoot(root);
        if (overlapping) {
            void window.showWarningMessage(DeepnoteCloud.syncFolderOverlaps(label(root), label(overlapping)));

            return undefined;
        }

        return { root, isFirstSync: !(await hasSyncManifest(getFilePath(root))) };
    }

    private async confirmFirstSync(root: Uri): Promise<boolean> {
        const choice = await window.showInformationMessage(
            DeepnoteCloud.firstSyncConfirm(label(root)),
            { modal: true },
            DeepnoteCloud.downloadProjects
        );

        return choice === DeepnoteCloud.downloadProjects;
    }

    private async findOverlappingRoot(root: Uri): Promise<Uri | undefined> {
        // A filesystem or drive root is its own parent, and must not overlap itself.
        const parent = dirname(root);
        const outer = isEqual(parent, root) ? undefined : await findSyncManifestRoot(getFilePath(parent));
        if (outer) {
            return Uri.file(outer);
        }

        // Any `exclude` but `null` keeps `files.exclude` applied, which can hide a nested manifest.
        const [inner] = await workspace.findFiles(new RelativePattern(root, `*/**/${SYNC_MANIFEST_FILENAME}`), null, 1);

        return inner && dirname(inner);
    }

    private async saveUnsavedNotebooks(): Promise<boolean> {
        const unsaved = unsavedDeepnoteNotebooks();
        if (unsaved.length === 0) {
            return true;
        }

        const choice = await window.showWarningMessage(
            DeepnoteCloud.syncUnsavedNotebooks(unsaved.length),
            { modal: true },
            DeepnoteCloud.saveAndSync
        );
        if (choice !== DeepnoteCloud.saveAndSync) {
            return false;
        }

        await Promise.allSettled(unsaved.map((notebook) => notebook.save()));

        const stillUnsaved = unsavedDeepnoteNotebooks().length;
        if (stillUnsaved > 0) {
            void window.showWarningMessage(DeepnoteCloud.syncStillUnsaved(stillUnsaved));

            return false;
        }

        return true;
    }

    private async showSummary(result: WorkspaceSyncResult): Promise<void> {
        const count = (action: ProjectSyncOutcome['action']) =>
            result.projects.filter((project) => project.action === action).length;

        const sentences = [
            DeepnoteCloud.syncFinished(
                count('pulled'),
                count('pushed'),
                count('unchanged'),
                count('skipped-conflict'),
                count('error')
            )
        ];
        const missingInCloud = count('missing-in-cloud');
        if (missingInCloud > 0) {
            sentences.push(DeepnoteCloud.syncMissingInCloud(missingInCloud));
        }
        if (result.untrackedFiles.length > 0) {
            sentences.push(DeepnoteCloud.syncUntrackedFiles(result.untrackedFiles.length));
        }

        const message = sentences.join(' ');
        const choice = result.success
            ? await window.showInformationMessage(message, DeepnoteCloud.showLog)
            : await window.showWarningMessage(message, DeepnoteCloud.showLog);
        if (choice === DeepnoteCloud.showLog) {
            await commands.executeCommand(Commands.ViewJupyterOutput);
        }
    }

    private async syncChosenFolder(): Promise<void> {
        let target: { root: Uri; isFirstSync: boolean } | undefined;
        try {
            target = await this.chooseSyncTarget();
        } catch (error) {
            void showCloudError(DeepnoteCloud.syncFailed, error);

            return;
        }
        if (!target) {
            return;
        }

        const { root, isFirstSync } = target;
        if (isFirstSync && !(await this.confirmFirstSync(root))) {
            return;
        }

        const token = await this.apiTokenService.getOrPromptToken(root, root);
        if (!token) {
            return;
        }

        if (!(await this.saveUnsavedNotebooks())) {
            return;
        }

        let result: WorkspaceSyncResult;
        try {
            result = await window.withProgress(
                { location: ProgressLocation.Notification, title: DeepnoteCloud.syncing },
                () =>
                    this.runSyncWorkspace({
                        rootDir: getFilePath(root),
                        baseUrl: getApiEndpoint(root),
                        token,
                        onConflict: (conflict) => this.askConflict(conflict),
                        onEvent: logSyncEvent
                    })
            );
        } catch (error) {
            void showCloudError(DeepnoteCloud.syncFailed, error, root);

            return;
        }

        // Not awaited, so a summary left on screen does not hold the in-progress flag.
        void this.showSummary(result);
    }

    private async syncWithDeepnoteCloud(): Promise<void> {
        if (this.syncInProgress) {
            void window.showInformationMessage(DeepnoteCloud.syncInProgress);

            return;
        }

        this.syncInProgress = true;
        try {
            await this.syncChosenFolder();
        } finally {
            this.syncInProgress = false;
        }
    }
}
