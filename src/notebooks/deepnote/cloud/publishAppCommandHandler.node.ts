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
import { commands, Progress, ProgressLocation, QuickPickItem, Uri, window, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { Commands } from '../../../platform/common/constants';
import { getFilePath } from '../../../platform/common/platform/fs-paths';
import { IExtensionContext } from '../../../platform/common/types';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { basename, extUriBiasedIgnorePathCase, relativePath } from '../../../platform/vscode-path/resources';
import { getApiEndpoint } from '../importClient.node';
import { showCloudError } from './cloudErrors.node';
import { showPublishedAppUrl } from './publishedAppUrl.node';
import { IDeepnoteApiTokenService, IDeepnoteCloudOperationLock, SyncWithDeepnoteCloudTarget } from './types';

const SETTINGS_STATE_KEY = 'deepnote.publishApp.folderSettings';
const MAX_LISTED_PATHS = 10;

type PublishAppSettings = { projectId: string; projectName: string };
type PublishTarget = PublishAppSettings | { newProjectName: string };

/** `listAllProjects` passes the API's `projectType` through, but `SyncProject` does not declare it. */
export type ListedProject = SyncProject & { projectType?: string };

interface ProjectPickItem extends QuickPickItem {
    projectId?: string;
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
    protected listProjects(baseUrl: string, token: string): Promise<ListedProject[]> {
        return listAllProjects(baseUrl, token);
    }

    /** Seam for tests, which never reach the network. */
    protected runPublishApp(options: PublishAppOptions): Promise<PublishAppResult> {
        return publishApp(options);
    }

    private async askNewProjectName(): Promise<string | undefined> {
        const name = await window.showInputBox({
            title: DeepnoteCloud.newDataApp,
            prompt: DeepnoteCloud.newDataAppPrompt,
            validateInput: (value) => (value.trim() ? undefined : DeepnoteCloud.newDataAppNameRequired)
        });

        return name?.trim() || undefined;
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
    ): Promise<PublishTarget | undefined> {
        let projects: ListedProject[];
        try {
            projects = await window.withProgress(
                { location: ProgressLocation.Notification, title: DeepnoteCloud.loadingProjects },
                () => this.listProjects(getApiEndpoint(folder), token)
            );
        } catch (error) {
            void showCloudError(DeepnoteCloud.loadProjectsFailed, error, folder);

            return undefined;
        }

        const isCurrent = (item: ProjectPickItem) =>
            item.projectId !== undefined && item.projectId === current?.projectId;
        const dataApps = projects
            .filter((project) => project.projectType === 'data_app')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((project): ProjectPickItem => ({
                label: project.name,
                description: project.folder?.path.map((segment) => segment.name).join(' / '),
                projectId: project.id
            }))
            .map((item) => (isCurrent(item) ? { ...item, detail: DeepnoteCloud.currentChoice } : item));
        const newDataApp: ProjectPickItem = {
            label: DeepnoteCloud.newDataApp,
            description: DeepnoteCloud.newDataAppDescription
        };
        const picked = await window.showQuickPick(currentFirst([newDataApp, ...dataApps], isCurrent), {
            placeHolder: DeepnoteCloud.chooseProject
        });
        if (!picked) {
            return undefined;
        }
        if (picked.projectId === undefined) {
            const newProjectName = await this.askNewProjectName();

            return newProjectName === undefined ? undefined : { newProjectName };
        }

        const settings: PublishAppSettings = { projectId: picked.projectId, projectName: picked.label };
        await this.saveSettings(folder, settings);

        return settings;
    }

    private async chooseTarget(folder: Uri, token: string): Promise<PublishTarget | undefined> {
        const synced = await this.findSyncedProject(folder);
        if (synced) {
            const choice = await window.showInformationMessage(
                DeepnoteCloud.publishSavedPrompt(basename(folder), synced.projectName),
                { modal: true },
                DeepnoteCloud.publish
            );

            return choice === DeepnoteCloud.publish ? synced : undefined;
        }

        const saved = this.savedSettings()[folder.toString()];
        if (!saved) {
            return this.chooseProject(folder, token, undefined);
        }

        const choice = await window.showInformationMessage(
            DeepnoteCloud.publishSavedPrompt(basename(folder), saved.projectName),
            { modal: true },
            DeepnoteCloud.publish,
            DeepnoteCloud.changeSettings
        );
        if (choice === DeepnoteCloud.publish) {
            return saved;
        }

        return choice === DeepnoteCloud.changeSettings ? this.chooseProject(folder, token, saved) : undefined;
    }

    private async findSyncedProject(folder: Uri): Promise<PublishAppSettings | undefined> {
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

    /**
     * Sync First runs `@deepnote/cloud-sync`'s `syncWorkspace` with `allFiles`, which downloads Deepnote's working files
     * over every project's `.files` folder without checking for local edits, so it would replace an app folder that is
     * in, or contains, one of them.
     */
    private async overlapsProjectFiles(folder: Uri, syncRoot: Uri): Promise<boolean> {
        let manifest: SyncManifest;
        try {
            manifest = await loadSyncManifest(getFilePath(syncRoot));
        } catch (error) {
            logger.warn('Could not read the sync manifest to check the app folder', error);

            return true;
        }

        return Object.values(manifest.projects).some(({ dir }) => {
            const filesFolder = Uri.joinPath(syncRoot, projectFilesDir(dir));

            return (
                extUriBiasedIgnorePathCase.isEqualOrParent(folder, filesFolder) ||
                extUriBiasedIgnorePathCase.isEqualOrParent(filesFolder, folder)
            );
        });
    }

    private async publish(folder: Uri, target: PublishTarget, token: string, force: boolean): Promise<void> {
        const syncRoot = await findSyncManifestRoot(getFilePath(folder)).catch((error) => {
            // publishApp looks up the same sync root and reports why it is unusable.
            logger.debug('Could not look up the sync root of the app folder', error);

            return undefined;
        });

        let mirrorIncompleteRoot: string | undefined;
        let savingCreatedProject: Promise<void> | undefined;
        const publishing = async (): Promise<{ result: PublishAppResult } | { error: unknown }> => {
            try {
                const result = await window.withProgress(
                    { location: ProgressLocation.Notification, title: DeepnoteCloud.publishing(basename(folder)) },
                    (progress) => {
                        const onEvent = this.progressReporter(progress, {
                            onMirrorIncomplete: (root) => (mirrorIncompleteRoot = root),
                            onProjectCreated: (project) => (savingCreatedProject = this.saveSettings(folder, project))
                        });

                        return this.runPublishApp({
                            dir: getFilePath(folder),
                            ...('projectId' in target
                                ? { projectId: target.projectId }
                                : { create: { name: target.newProjectName } }),
                            baseUrl: getApiEndpoint(folder),
                            token,
                            force,
                            onEvent
                        });
                    }
                );

                return { result };
            } catch (error) {
                return { error };
            }
        };
        const outcome = syncRoot
            ? await this.operationLock.tryRunExclusive(publishing, () => {
                  void window.showInformationMessage(DeepnoteCloud.cloudOperationInProgress);
              })
            : await publishing();
        if (!outcome) {
            return;
        }

        // Saved as soon as Deepnote reports the project, even when a later step fails, so publishing again goes to it
        // instead of creating another.
        await savingCreatedProject;

        if ('error' in outcome) {
            if (outcome.error instanceof PublishDivergedError && 'projectId' in target) {
                await this.resolveDivergence(folder, target, token, outcome.error);
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

        const target = await this.chooseTarget(folder, token);
        if (!target) {
            return;
        }

        await this.publish(folder, target, token, false);
    }

    private progressReporter(
        progress: Progress<{ message?: string; increment?: number }>,
        {
            onMirrorIncomplete,
            onProjectCreated
        }: {
            onMirrorIncomplete: (syncRoot: string) => void;
            onProjectCreated: (project: PublishAppSettings) => void;
        }
    ): (event: PublishAppEvent) => void {
        let total = 0;
        let uploaded = 0;

        return (event) => {
            switch (event.kind) {
                case 'project-created':
                    logger.info(`Created the data app project "${event.name}" (${event.projectId})`);
                    onProjectCreated({ projectId: event.projectId, projectName: event.name });

                    return;
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
        const syncRoot = Uri.file(error.syncRoot);
        const canSyncFirst = !(await this.overlapsProjectFiles(folder, syncRoot));
        const choice = await window.showWarningMessage(
            DeepnoteCloud.publishDiverged(error.paths.length, listPaths(error.paths)),
            {
                modal: true,
                detail: canSyncFirst ? DeepnoteCloud.publishDivergedDetail : DeepnoteCloud.publishDivergedInFilesDetail
            },
            ...(canSyncFirst ? [DeepnoteCloud.syncFirst] : []),
            DeepnoteCloud.force
        );
        if (choice === DeepnoteCloud.force) {
            await this.publish(folder, settings, token, true);

            return;
        }
        if (choice !== DeepnoteCloud.syncFirst) {
            return;
        }

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

    private async saveSettings(folder: Uri, settings: PublishAppSettings): Promise<void> {
        await this.extensionContext.workspaceState.update(SETTINGS_STATE_KEY, {
            ...this.savedSettings(),
            [folder.toString()]: settings
        });
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
