import { listAllProjects, PROJECT_STATIC_ROOT, type SyncProject } from '@deepnote/cloud';
import {
    findSyncManifestRoot,
    loadSyncManifest,
    projectFilesDir,
    publishApp,
    PublishDivergedError,
    type PublishAppEvent,
    type PublishAppOptions,
    type PublishAppResult,
    type SyncManifest,
    type WorkspaceSyncResult
} from '@deepnote/cloud-sync';
import { inject, injectable } from 'inversify';
import { commands, Disposable, Progress, ProgressLocation, QuickPickItem, Uri, window, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { Commands } from '../../../platform/common/constants';
import { getFilePath } from '../../../platform/common/platform/fs-paths';
import { IExtensionContext } from '../../../platform/common/types';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { basename, relativePath } from '../../../platform/vscode-path/resources';
import { getApiEndpoint } from '../importClient.node';
import { showCloudError } from './cloudErrors.node';
import { showPublishedAppUrl } from './publishedAppUrl.node';
import { IDeepnoteApiTokenService, IDeepnoteCloudOperationLock, SyncWithDeepnoteCloudTarget } from './types';

const SETTINGS_STATE_KEY = 'deepnote.publishApp.folderSettings';
const MAX_LISTED_PATHS = 10;

type PublishAppSettings = { projectId: string; projectName: string; apiAccess: boolean };
type ProjectChoice = Pick<PublishAppSettings, 'projectId' | 'projectName'>;

interface ProjectPickItem extends QuickPickItem {
    projectId: string;
}

interface ApiAccessPickItem extends QuickPickItem {
    apiAccess: boolean;
}

/** `showQuickPick` cannot preselect an item, so the current choice is listed first instead. */
function currentFirst<T>(items: T[], isCurrent: (item: T) => boolean): T[] {
    return [...items.filter(isCurrent), ...items.filter((item) => !isCurrent(item))];
}

function listPaths(paths: string[]): string {
    const listed = paths.slice(0, MAX_LISTED_PATHS).join(', ');
    const rest = paths.length - MAX_LISTED_PATHS;

    return rest > 0 ? `${listed} ${DeepnoteCloud.andMore(rest)}` : listed;
}

@injectable()
export class PublishAppCommandHandler implements IExtensionSyncActivationService {
    constructor(
        @inject(IDeepnoteApiTokenService) private readonly apiTokenService: IDeepnoteApiTokenService,
        @inject(IDeepnoteCloudOperationLock) private readonly operationLock: IDeepnoteCloudOperationLock,
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext
    ) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.PublishApp, (arg?: unknown) =>
                this.publishFromCommand(arg instanceof Uri ? arg : undefined)
            )
        );
    }

    /** Seam for tests, which never reach the network. */
    protected listProjects(baseUrl: string, token: string): Promise<SyncProject[]> {
        return listAllProjects(baseUrl, token);
    }

    /** Seam for tests, which never reach the network. */
    protected runPublishApp(options: PublishAppOptions): Promise<PublishAppResult> {
        return publishApp(options);
    }

    private async chooseApiAccess(current: boolean | undefined): Promise<boolean | undefined> {
        const items = (
            [
                { label: DeepnoteCloud.apiAccessOff, detail: DeepnoteCloud.apiAccessOffDetail, apiAccess: false },
                { label: DeepnoteCloud.apiAccessOn, detail: DeepnoteCloud.apiAccessOnDetail, apiAccess: true }
            ] satisfies ApiAccessPickItem[]
        ).map((item) =>
            item.apiAccess === current ? { ...item, detail: `${DeepnoteCloud.currentChoice}. ${item.detail}` } : item
        );
        const picked = await window.showQuickPick(
            currentFirst(items, (item) => item.apiAccess === current),
            { placeHolder: DeepnoteCloud.chooseApiAccess }
        );

        return picked?.apiAccess;
    }

    private async chooseFolder(): Promise<Uri | undefined> {
        const [folder] =
            (await window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: workspace.workspaceFolders?.[0]?.uri,
                title: DeepnoteCloud.chooseAppFolderTitle,
                openLabel: DeepnoteCloud.publish
            })) ?? [];

        return folder;
    }

    private async chooseProject(
        folder: Uri,
        token: string,
        current: PublishAppSettings | undefined
    ): Promise<ProjectChoice | undefined> {
        const synced = await this.findSyncedProject(folder);
        if (synced) {
            return synced;
        }

        let projects: SyncProject[];
        try {
            projects = await window.withProgress(
                { location: ProgressLocation.Notification, title: DeepnoteCloud.loadingProjects },
                () => this.listProjects(getApiEndpoint(folder), token)
            );
        } catch (error) {
            void showCloudError(DeepnoteCloud.loadProjectsFailed, error, folder);

            return undefined;
        }

        const isCurrent = (item: ProjectPickItem) => item.projectId === current?.projectId;
        const items = [...projects]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((project): ProjectPickItem => ({
                label: project.name,
                description: project.folder?.path.map((segment) => segment.name).join(' / '),
                projectId: project.id
            }))
            .map((item) => (isCurrent(item) ? { ...item, detail: DeepnoteCloud.currentChoice } : item));
        const picked = await window.showQuickPick(currentFirst(items, isCurrent), {
            placeHolder: DeepnoteCloud.chooseProject
        });

        return picked && { projectId: picked.projectId, projectName: picked.label };
    }

    private async collectSettings(
        folder: Uri,
        token: string,
        current?: PublishAppSettings
    ): Promise<PublishAppSettings | undefined> {
        const project = await this.chooseProject(folder, token, current);
        if (!project) {
            return undefined;
        }

        const apiAccess = await this.chooseApiAccess(current?.apiAccess);
        if (apiAccess === undefined) {
            return undefined;
        }

        const settings: PublishAppSettings = { ...project, apiAccess };
        await this.extensionContext.workspaceState.update(SETTINGS_STATE_KEY, {
            ...this.savedSettings(),
            [folder.toString()]: settings
        });

        return settings;
    }

    private async findSyncedProject(folder: Uri): Promise<ProjectChoice | undefined> {
        let root: string | undefined;
        let manifest: SyncManifest;
        try {
            root = await findSyncManifestRoot(getFilePath(folder));
            if (!root) {
                return undefined;
            }
            manifest = await loadSyncManifest(root);
        } catch (error) {
            logger.warn('Could not read the sync manifest above the app folder', error);

            return undefined;
        }

        const folderPath = relativePath(Uri.file(root), folder);
        if (folderPath === undefined) {
            return undefined;
        }

        for (const [projectId, { dir }] of Object.entries(manifest.projects)) {
            if (folderPath === dir || folderPath.startsWith(`${dir}/`)) {
                return { projectId, projectName: dir.slice(dir.lastIndexOf('/') + 1) };
            }
        }

        return undefined;
    }

    private async publish(folder: Uri, settings: PublishAppSettings, token: string, force: boolean): Promise<void> {
        const syncRoot = await findSyncManifestRoot(getFilePath(folder)).catch((error) => {
            // publishApp looks up the same sync root and reports why it is unusable.
            logger.debug('Could not look up the sync root of the app folder', error);

            return undefined;
        });

        let lease: Disposable | undefined;
        if (syncRoot) {
            lease = this.operationLock.tryAcquire();
            if (!lease) {
                void window.showInformationMessage(DeepnoteCloud.cloudOperationInProgress);

                return;
            }
        }

        let mirrorIncompleteRoot: string | undefined;
        let outcome: { result: PublishAppResult } | { error: unknown };
        try {
            const result = await window.withProgress(
                { location: ProgressLocation.Notification, title: DeepnoteCloud.publishing(basename(folder)) },
                (progress) => {
                    const onEvent = this.progressReporter(progress, (root) => (mirrorIncompleteRoot = root));

                    return this.runPublishApp({
                        dir: getFilePath(folder),
                        projectId: settings.projectId,
                        baseUrl: getApiEndpoint(folder),
                        token,
                        apiAccess: settings.apiAccess,
                        force,
                        onEvent
                    });
                }
            );
            outcome = { result };
        } catch (error) {
            outcome = { error };
        } finally {
            lease?.dispose();
        }

        if ('error' in outcome) {
            if (outcome.error instanceof PublishDivergedError) {
                await this.resolveDivergence(folder, settings, token, outcome.error);
            } else {
                void showCloudError(DeepnoteCloud.publishFailed, outcome.error, folder);
            }

            return;
        }

        const { result } = outcome;
        if (result.errors.length > 0) {
            void this.showPartialFailure(result.errors.length);
        } else if (result.appUrl) {
            void showPublishedAppUrl(DeepnoteCloud.publishSucceeded(result.appUrl), result.appUrl);
        }
        if (mirrorIncompleteRoot) {
            void window.showWarningMessage(DeepnoteCloud.publishMirrorIncomplete(mirrorIncompleteRoot));
        }
    }

    private async publishFromCommand(arg: Uri | undefined): Promise<void> {
        const folder = arg ?? (await this.chooseFolder());
        if (!folder) {
            return;
        }

        const token = await this.apiTokenService.getOrPromptToken(folder);
        if (!token) {
            return;
        }

        const saved = this.savedSettings()[folder.toString()];
        let settings: PublishAppSettings | undefined;
        if (saved) {
            const choice = await window.showInformationMessage(
                DeepnoteCloud.publishSavedPrompt(basename(folder), saved.projectName),
                {
                    modal: true,
                    detail: DeepnoteCloud.publishSavedDetail(saved.apiAccess ? DeepnoteCloud.on : DeepnoteCloud.off)
                },
                DeepnoteCloud.publish,
                DeepnoteCloud.changeSettings
            );
            if (choice === DeepnoteCloud.publish) {
                settings = saved;
            } else if (choice === DeepnoteCloud.changeSettings) {
                settings = await this.collectSettings(folder, token, saved);
            }
        } else {
            settings = await this.collectSettings(folder, token);
        }
        if (!settings) {
            return;
        }

        await this.publish(folder, settings, token, false);
    }

    private progressReporter(
        progress: Progress<{ message?: string; increment?: number }>,
        onMirrorIncomplete: (syncRoot: string) => void
    ): (event: PublishAppEvent) => void {
        let total = 0;
        let uploaded = 0;

        return (event) => {
            switch (event.kind) {
                case 'publishing':
                    total = event.fileCount;

                    return;
                case 'file-uploaded':
                    uploaded++;
                    progress.report({
                        message: DeepnoteCloud.publishProgress(uploaded, total),
                        increment: 100 / total
                    });

                    return;
                case 'operation-failed':
                    logger.warn(`${event.operation} failed for ${event.path}: ${event.message}`);

                    return;
                case 'mirror-incomplete':
                    onMirrorIncomplete(event.syncRoot);
                    for (const failure of event.failures) {
                        logger.warn(`Could not update the synced copy of ${failure}`);
                    }

                    return;
                default:
                    logger.debug('Deepnote app publish event', event);
            }
        };
    }

    private async resolveDivergence(
        folder: Uri,
        settings: PublishAppSettings,
        token: string,
        error: PublishDivergedError
    ): Promise<void> {
        const choice = await window.showWarningMessage(
            DeepnoteCloud.publishDiverged(error.paths.length, listPaths(error.paths)),
            { modal: true, detail: DeepnoteCloud.publishDivergedDetail },
            DeepnoteCloud.syncFirst,
            DeepnoteCloud.force
        );
        if (choice === DeepnoteCloud.force) {
            await this.publish(folder, settings, token, true);

            return;
        }
        if (choice !== DeepnoteCloud.syncFirst) {
            return;
        }

        const syncRoot = Uri.file(error.syncRoot);
        const target: SyncWithDeepnoteCloudTarget = { root: syncRoot, allFiles: true };
        const result = await commands.executeCommand<WorkspaceSyncResult | undefined>(
            Commands.SyncWithDeepnoteCloud,
            target
        );
        if (!result) {
            return;
        }

        // Only a download writes Deepnote's versions locally; a push of this project uploads local files instead.
        const project = result.projects.find((outcome) => outcome.projectId === settings.projectId);
        if (project && (project.filesDownloaded ?? 0) > 0) {
            const appFiles = Uri.joinPath(syncRoot, projectFilesDir(project.path), PROJECT_STATIC_ROOT);
            void window.showInformationMessage(DeepnoteCloud.publishSyncedChanges(workspace.asRelativePath(appFiles)));

            return;
        }

        // Notifications render `[label](command:...)` as runnable links, and this name comes from the Deepnote API.
        const projectName = settings.projectName.replace(/\]\(/g, '] (');
        void window.showWarningMessage(DeepnoteCloud.publishSyncMissedAppFiles(projectName));
    }

    private savedSettings(): Record<string, PublishAppSettings> {
        return this.extensionContext.workspaceState.get<Record<string, PublishAppSettings>>(SETTINGS_STATE_KEY, {});
    }

    private async showPartialFailure(count: number): Promise<void> {
        const choice = await window.showWarningMessage(
            DeepnoteCloud.publishPartiallyFailed(count),
            DeepnoteCloud.showLog
        );
        if (choice === DeepnoteCloud.showLog) {
            await commands.executeCommand(Commands.ViewJupyterOutput);
        }
    }
}
