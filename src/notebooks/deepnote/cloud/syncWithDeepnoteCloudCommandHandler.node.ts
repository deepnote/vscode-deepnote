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
    TextDocument,
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
import { dirname, extUriBiasedIgnorePathCase, isEqual } from '../../../platform/vscode-path/resources';
import { getApiEndpoint } from '../importClient.node';
import { showCloudError } from './cloudErrors.node';
import { IDeepnoteApiTokenService } from './types';

interface RootPickItem extends QuickPickItem {
    root: Uri;
}

function workspaceRelativeUri(uri: Uri): string {
    return workspace.asRelativePath(uri);
}

async function offerToSyncNewFolder(): Promise<void> {
    const choice = await window.showInformationMessage(DeepnoteCloud.noSyncedFolder, DeepnoteCloud.syncNewFolder);
    if (choice === DeepnoteCloud.syncNewFolder) {
        await commands.executeCommand(Commands.SyncNewFolderWithDeepnoteCloud);
    }
}

function reportSyncFailure(error: unknown) {
    void showCloudError(DeepnoteCloud.syncFailed, error);
}

function unsavedDeepnoteDocuments(): (NotebookDocument | TextDocument)[] {
    return [
        ...workspace.notebookDocuments.filter((notebook) => notebook.notebookType === 'deepnote' && notebook.isDirty),
        // "Reopen Editor With… > Text Editor" opens a .deepnote file as a text document. Notebook cells are text
        // documents with the notebook's path too, but not with the `file` scheme.
        ...workspace.textDocuments.filter(
            (document) => document.isDirty && document.uri.scheme === 'file' && document.uri.path.endsWith('.deepnote')
        )
    ];
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
        case 'file-transferred':
        case 'listing-projects':
            logger.debug('Deepnote Cloud sync event', event);

            return;
        default:
            event satisfies never;
            logger.error('Unknown Deepnote Cloud sync event', event);
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
            commands.registerCommand(Commands.SyncWithDeepnoteCloud, this.syncWithDeepnoteCloud, this),
            commands.registerCommand(Commands.SyncNewFolderWithDeepnoteCloud, this.syncNewFolderWithDeepnoteCloud, this)
        );
    }

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
            default:
                conflict satisfies never;
                logger.error(`Skipped an unknown conflict ${conflict}`);
                return Promise.resolve('skip');
        }
    }

    private async checkSyncTarget(root: Uri): Promise<{ isFirstSync: boolean } | undefined> {
        if (!workspace.getWorkspaceFolder(root)) {
            void window.showWarningMessage(DeepnoteCloud.syncFolderOutsideWorkspace(getFilePath(root)));

            return undefined;
        }

        const overlapping = await this.findOverlappingRoot(root);
        if (overlapping) {
            void window.showWarningMessage(
                DeepnoteCloud.syncFolderOverlaps(workspaceRelativeUri(root), workspaceRelativeUri(overlapping))
            );

            return undefined;
        }

        const rootHasSyncManifest = await hasSyncManifest(getFilePath(root));

        return { isFirstSync: !rootHasSyncManifest };
    }

    private async chooseNewRoot(): Promise<Uri | undefined> {
        const folders = await window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: workspace.workspaceFolders?.[0]?.uri,
            title: DeepnoteCloud.chooseSyncFolderTitle,
            openLabel: DeepnoteCloud.chooseSyncFolderOpenLabel
        });
        const folder = folders?.at(0);
        if (!folder) {
            return undefined;
        }

        const root = await findSyncManifestRoot(getFilePath(folder));

        return root ? Uri.file(root) : folder;
    }

    private async chooseSyncedRoot(): Promise<Uri | undefined> {
        const allSyncManifestFiles = await workspace.findFiles(`**/${SYNC_MANIFEST_FILENAME}`, '**/node_modules/**');
        const roots = allSyncManifestFiles
            .map((manifest) => dirname(manifest))
            .sort((a, b) => workspaceRelativeUri(a).localeCompare(workspaceRelativeUri(b)));

        if (roots.length === 0) {
            // Not awaited, so the in-progress flag is clear by the time the offer's button runs the other command.
            void offerToSyncNewFolder();

            return undefined;
        }
        if (roots.length === 1) {
            return roots[0];
        }

        // Deepnote notebook URIs carry a `?notebook=` query, and `isEqualOrParent` compares queries.
        const activeFile = (window.activeNotebookEditor?.notebook.uri ?? window.activeTextEditor?.document.uri)?.with({
            query: '',
            fragment: ''
        });
        const activeIndex = activeFile
            ? roots.findIndex((root) => extUriBiasedIgnorePathCase.isEqualOrParent(activeFile, root))
            : -1;
        if (activeIndex > 0) {
            roots.unshift(...roots.splice(activeIndex, 1));
        }

        const items: RootPickItem[] = roots.map((root) => ({ label: workspaceRelativeUri(root), root }));
        const picked = await window.showQuickPick(items, { placeHolder: DeepnoteCloud.chooseSyncFolder });

        return picked?.root;
    }

    private async confirmFirstSync(root: Uri): Promise<boolean> {
        const choice = await window.showInformationMessage(
            DeepnoteCloud.firstSyncConfirm(workspaceRelativeUri(root)),
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

    private async runOneSyncAtATime(sync: () => Promise<void>): Promise<void> {
        if (this.syncInProgress) {
            void window.showInformationMessage(DeepnoteCloud.syncInProgress);

            return;
        }

        this.syncInProgress = true;
        try {
            await sync();
        } finally {
            this.syncInProgress = false;
        }
    }

    private async saveUnsavedNotebooks(): Promise<boolean> {
        const unsaved = unsavedDeepnoteDocuments();
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

        await Promise.allSettled(unsaved.map((document) => document.save()));

        const stillUnsaved = unsavedDeepnoteDocuments().length;
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

    private async syncFolder(root: Uri): Promise<void> {
        const target = await this.checkSyncTarget(root).catch(reportSyncFailure);
        if (!target) {
            return;
        }
        if (target.isFirstSync && !(await this.confirmFirstSync(root))) {
            return;
        }

        const token = await this.apiTokenService.getOrPromptToken(root);
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

    private async syncNewFolderWithDeepnoteCloud(): Promise<void> {
        await this.runOneSyncAtATime(async () => {
            const root = await this.chooseNewRoot().catch(reportSyncFailure);
            if (root != null) {
                await this.syncFolder(root);
            }
        });
    }

    private async syncWithDeepnoteCloud(): Promise<void> {
        await this.runOneSyncAtATime(async () => {
            const root = await this.chooseSyncedRoot().catch(reportSyncFailure);
            if (root != null) {
                await this.syncFolder(root);
            }
        });
    }
}
