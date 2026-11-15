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

const INTEGRATED_BROWSER_OPEN_COMMAND = 'workbench.action.browser.open';
const SIMPLE_BROWSER_OPEN_COMMAND = 'simpleBrowser.api.open';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

@injectable()
export class AppPreviewCommandHandler implements IExtensionSyncActivationService {
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
        const folders = await window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: workspace.workspaceFolders?.[0]?.uri,
            title: DeepnoteAppPreview.chooseFolderTitle,
            openLabel: DeepnoteAppPreview.preview
        });

        return folders?.at(0);
    }

    /**
     * The Simple Browser hands the integrated browser only the URL, so each preview would open another tab. With the
     * undocumented `reuseUrlFilter` option, the integrated browser instead loads the URL in the tab already showing the
     * session's origin, which is unique per folder, and focuses it. VS Code versions without the option ignore it. The
     * filter's path is a glob, and an http URL without a path gets `/`, which as a glob matches no page, hence `/**`.
     *
     * Editors without the Simple Browser reject with `command 'simpleBrowser.api.open' not found`, so any rejection
     * falls back to the system browser.
     */
    private async open(session: AppPreviewSession): Promise<void> {
        const url = session.browserUri;
        try {
            if (await this.shouldUseIntegratedBrowser()) {
                await commands.executeCommand(INTEGRATED_BROWSER_OPEN_COMMAND, {
                    url: url.toString(true),
                    reuseUrlFilter: `${url.scheme}://${url.authority}/**`
                });
            } else {
                await commands.executeCommand(SIMPLE_BROWSER_OPEN_COMMAND, url, {
                    viewColumn: ViewColumn.Beside,
                    preserveFocus: true
                });
            }
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

    /**
     * Mirrors the Simple Browser, which honours `simpleBrowser.useIntegratedBrowser` only in the VS Code versions that
     * register it. A value left in the settings by an older version has no default, and is ignored.
     */
    private async shouldUseIntegratedBrowser(): Promise<boolean> {
        const config = workspace.getConfiguration('simpleBrowser');
        const isRegistered = config.inspect<boolean>('useIntegratedBrowser')?.defaultValue !== undefined;
        if (isRegistered && !config.get<boolean>('useIntegratedBrowser', true)) {
            return false;
        }

        return (await commands.getCommands(true)).includes(INTEGRATED_BROWSER_OPEN_COMMAND);
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
