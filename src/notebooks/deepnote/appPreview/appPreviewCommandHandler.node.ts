import { inject, injectable } from 'inversify';
import { commands, env, Uri, ViewColumn, window, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { Commands } from '../../../platform/common/constants';
import { IDisposableRegistry, IExtensionContext } from '../../../platform/common/types';
import { DeepnoteAppPreview } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { basename } from '../../../platform/vscode-path/resources';
import type { AppPreviewOperation } from './appPreviewApi.node';
import { AppPreviewSession } from './appPreviewSession.node';
import { resolvePreviewProject } from './appPreviewWorkspace.node';

const SIMPLE_BROWSER_OPEN_COMMAND = 'simpleBrowser.api.open';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Runs **Deepnote: Preview App**: serves an app folder from a preview session and opens it in the built-in browser. */
@injectable()
export class AppPreviewCommandHandler implements IExtensionSyncActivationService {
    // Keyed by folder URI. The pending start is stored, so a second run during startup reuses it.
    private readonly sessions = new Map<string, Promise<AppPreviewSession>>();

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.PreviewApp, (arg?: unknown) =>
                this.previewFromCommand(arg instanceof Uri ? arg : undefined)
            )
        );
    }

    private async chooseFolder(): Promise<Uri | undefined> {
        const [folder] =
            (await window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: workspace.workspaceFolders?.[0]?.uri,
                title: DeepnoteAppPreview.chooseFolderTitle,
                openLabel: DeepnoteAppPreview.preview
            })) ?? [];

        return folder;
    }

    /**
     * Opens the page in VS Code's built-in browser. An editor without the Simple Browser's command rejects with
     * `command 'simpleBrowser.api.open' not found`, as does a browser that fails, and gets the system browser instead.
     */
    private async open(session: AppPreviewSession): Promise<void> {
        try {
            await commands.executeCommand(SIMPLE_BROWSER_OPEN_COMMAND, session.browserUri, {
                viewColumn: ViewColumn.Beside,
                preserveFocus: true
            });
        } catch (error) {
            logger.warn(`Could not open the app preview in the built-in browser: ${errorMessage(error)}`);
            await env.openExternal(session.externalBrowserUri);
        }
    }

    private async previewFromCommand(arg: Uri | undefined): Promise<void> {
        const folder = arg ?? (await this.chooseFolder());
        if (!folder) {
            return;
        }

        let session: AppPreviewSession;
        try {
            session = await this.sessionFor(folder);
            await session.resolveUrls();
        } catch (error) {
            logger.error(`Could not start the app preview of ${folder.fsPath}`, error);
            void window.showErrorMessage(DeepnoteAppPreview.startFailed(errorMessage(error)));

            return;
        }

        await this.open(session);
    }

    private async sessionFor(folder: Uri): Promise<AppPreviewSession> {
        const key = folder.toString();
        const existing = this.sessions.get(key);
        if (existing) {
            const session = await existing;
            // A `.deepnote` file may have been added, removed or changed since the last run.
            session.setProject(await resolvePreviewProject(folder));

            return session;
        }

        const starting = this.startSession(folder);
        this.sessions.set(key, starting);
        try {
            return await starting;
        } catch (error) {
            this.sessions.delete(key);
            throw error;
        }
    }

    private async startSession(folder: Uri): Promise<AppPreviewSession> {
        const warned = new Set<AppPreviewOperation>();
        const session = new AppPreviewSession({
            folder,
            project: await resolvePreviewProject(folder),
            scripts: {
                appClient: Uri.joinPath(
                    this.extensionContext.extensionUri,
                    'dist',
                    'webviews',
                    'webview-side',
                    'appPreview',
                    'appClient.js'
                )
            },
            onUnsupported: (operation) => {
                if (warned.has(operation)) {
                    return;
                }
                warned.add(operation);
                void window.showWarningMessage(DeepnoteAppPreview.operationNotSupported(operation, basename(folder)));
            }
        });

        try {
            await session.start();
        } catch (error) {
            session.dispose();
            throw error;
        }
        this.disposables.push(session);

        return session;
    }
}
