import { getWorkspace, type Workspace } from '@deepnote/cloud';
import { findSyncManifestRoot } from '@deepnote/cloud-sync';
import dotenv from 'dotenv';
import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import { commands, ProgressLocation, Uri, window, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { IEncryptedStorage } from '../../../platform/common/application/types';
import { Commands } from '../../../platform/common/constants';
import { isFileNotFoundError } from '../../../platform/common/platform/errors';
import { getFilePath } from '../../../platform/common/platform/fs-paths';
import { IExtensionContext } from '../../../platform/common/types';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import {
    dirname,
    extUriBiasedIgnorePathCase,
    isEqual,
    removeTrailingPathSeparator
} from '../../../platform/vscode-path/resources';
import { getApiEndpoint } from '../importClient.node';
import { isRejectedTokenError } from './cloudErrors.node';
import { IDeepnoteApiTokenService } from './types';

const TOKEN_ENV_VAR = 'DEEPNOTE_TOKEN';
const ENV_FILE_NAME = '.env';
const TOKEN_STORAGE_SERVICE = 'deepnote-api-token';

// What a `.env` line or a shell would split or unquote on, plus control characters: `fetch` rejects a NUL in a header
// with an error that quotes the whole `Authorization` value, token included.
const INVALID_TOKEN_CHARACTERS = /[\s"'#\p{Cc}]/u;

function withoutQueryAndFragment(uri: Uri): Uri {
    return uri.with({ query: '', fragment: '' });
}

async function getStartFolder(resource: Uri): Promise<Uri> {
    const stats = await fs.promises.stat(getFilePath(resource)).catch(() => undefined);

    return stats?.isDirectory() ? resource : dirname(resource);
}

async function readFileBytes(filePath: string): Promise<Buffer | undefined> {
    try {
        return await fs.promises.readFile(filePath);
    } catch (error) {
        if (error instanceof Error && isFileNotFoundError(error)) {
            return undefined;
        }

        throw error;
    }
}

async function readTextFile(filePath: string): Promise<string | undefined> {
    return (await readFileBytes(filePath))?.toString('utf8');
}

@injectable()
export class DeepnoteApiTokenService implements IDeepnoteApiTokenService, IExtensionSyncActivationService {
    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IEncryptedStorage) private readonly encryptedStorage: IEncryptedStorage
    ) {}

    public activate(): void {
        this.extensionContext.subscriptions.push(
            commands.registerCommand(Commands.SetApiToken, async (resource?: Uri) => {
                await this.promptAndSaveToken(resource);
            }),
            commands.registerCommand(Commands.ClearApiToken, () => this.clearToken())
        );
    }

    public async getOrPromptToken(resource: Uri): Promise<string | undefined> {
        if (!this.ensureTrusted()) {
            return undefined;
        }

        if (resource.scheme !== 'file') {
            void window.showErrorMessage(DeepnoteCloud.localFilesOnly);

            return undefined;
        }

        return (await this.getToken(resource)) ?? (await this.promptAndSaveToken(resource));
    }

    public async getToken(resource: Uri): Promise<string | undefined> {
        if (!workspace.isTrusted || resource.scheme !== 'file') {
            return undefined;
        }

        const fromEnv = await this.findEnvToken(resource);
        if (fromEnv) {
            return fromEnv.token;
        }

        return (await this.encryptedStorage.retrieve(TOKEN_STORAGE_SERVICE, getApiEndpoint(resource))) || undefined;
    }

    /** Seam for tests, which never reach the network. */
    protected fetchWorkspace(baseUrl: string, token: string): Promise<Workspace | undefined> {
        return getWorkspace(baseUrl, token);
    }

    /** Resolves `undefined` after telling the user why the token was not accepted. */
    private async checkToken(apiUrl: string, token: string): Promise<{ workspaceName?: string } | undefined> {
        try {
            const deepnoteWorkspace = await window.withProgress(
                { location: ProgressLocation.Notification, title: DeepnoteCloud.checkingApiToken },
                () => this.fetchWorkspace(apiUrl, token)
            );

            return { workspaceName: deepnoteWorkspace?.name };
        } catch (error) {
            logger.warn('Could not check the Deepnote API token', error);
            void window.showErrorMessage(
                isRejectedTokenError(error)
                    ? DeepnoteCloud.apiTokenRejected
                    : DeepnoteCloud.apiTokenCheckFailed(error instanceof Error ? error.message : String(error))
            );

            return undefined;
        }
    }

    private async clearToken(): Promise<void> {
        if (!this.ensureTrusted()) {
            return;
        }

        const start = await this.resolveStart();
        if (!start) {
            return;
        }

        const key = getApiEndpoint(start);
        if (await this.encryptedStorage.retrieve(TOKEN_STORAGE_SERVICE, key)) {
            // EncryptedStorage logs a rejected delete and resolves, so reading the entry again is how a failure
            // shows up.
            await this.encryptedStorage.store(TOKEN_STORAGE_SERVICE, key, undefined);
            if (await this.encryptedStorage.retrieve(TOKEN_STORAGE_SERVICE, key)) {
                void window.showErrorMessage(DeepnoteCloud.apiTokenClearFailed);
            } else {
                void window.showInformationMessage(DeepnoteCloud.apiTokenCleared);
            }
        } else {
            void window.showInformationMessage(DeepnoteCloud.noApiTokenFound);
        }

        const fromEnv = await this.findEnvToken(start);
        if (fromEnv) {
            void window.showWarningMessage(DeepnoteCloud.apiTokenStillInEnv(workspace.asRelativePath(fromEnv.envUri)));
        }
    }

    private ensureTrusted(): boolean {
        if (workspace.isTrusted) {
            return true;
        }

        void window.showErrorMessage(DeepnoteCloud.workspaceNotTrusted);

        return false;
    }

    private async findEnvToken(resource: Uri): Promise<{ token: string; envUri: Uri } | undefined> {
        for (const dir of await this.getLookupDirs(resource)) {
            const token = (await this.readEnvFile(dir))?.[TOKEN_ENV_VAR]?.trim();
            if (token) {
                return { token, envUri: Uri.joinPath(dir, ENV_FILE_NAME) };
            }
        }

        return undefined;
    }

    private async findSyncRoot(folder: Uri): Promise<Uri | undefined> {
        try {
            const root = await findSyncManifestRoot(getFilePath(folder));

            return root ? Uri.file(root) : undefined;
        } catch (error) {
            logger.debug(`Could not look for a sync root above ${getFilePath(folder)}`, error);

            return undefined;
        }
    }

    /**
     * The folders to search for a `.env`, nearest first, from the folder of `resource` up to its sync root, or up to
     * its workspace folder root when there is no sync root.
     */
    private async getLookupDirs(resource: Uri): Promise<Uri[]> {
        const start = withoutQueryAndFragment(resource);
        const startFolder = await getStartFolder(start);
        const stopFolder = removeTrailingPathSeparator(
            (await this.findSyncRoot(startFolder)) ?? workspace.getWorkspaceFolder(start)?.uri ?? startFolder
        );

        // VS Code matches workspace folders case-insensitively on macOS and Windows and keeps a trailing slash from a
        // `.code-workspace` file. A stop folder that is not above `startFolder`, such as a workspace folder missing on
        // disk, must end the search, not widen it to the filesystem root.
        const dirs: Uri[] = [];
        for (let dir = startFolder; extUriBiasedIgnorePathCase.isEqualOrParent(dir, stopFolder); dir = dirname(dir)) {
            dirs.push(dir);
            if (extUriBiasedIgnorePathCase.isEqual(dir, stopFolder) || isEqual(dirname(dir), dir)) {
                break;
            }
        }

        return dirs;
    }

    private async pickWorkspaceFolder(): Promise<Uri | undefined> {
        const folders = workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            void window.showErrorMessage(DeepnoteCloud.openFolderFirst);

            return undefined;
        }

        const folder = folders.length === 1 ? folders[0] : await window.showWorkspaceFolderPick();
        if (folder && folder.uri.scheme !== 'file') {
            void window.showErrorMessage(DeepnoteCloud.localFilesOnly);

            return undefined;
        }

        return folder?.uri;
    }

    private async promptAndSaveToken(resource?: Uri): Promise<string | undefined> {
        if (!this.ensureTrusted()) {
            return undefined;
        }

        const start = await this.resolveStart(resource);
        if (!start) {
            return undefined;
        }

        const token = await this.promptForToken();
        if (!token) {
            return undefined;
        }

        const apiUrl = getApiEndpoint(start);
        const checked = await this.checkToken(apiUrl, token);
        if (!checked) {
            return undefined;
        }

        try {
            await this.encryptedStorage.store(TOKEN_STORAGE_SERVICE, apiUrl, token);
        } catch (error) {
            logger.error('Could not store the Deepnote API token', error);
            void window.showErrorMessage(
                DeepnoteCloud.apiTokenStoreFailed(error instanceof Error ? error.message : String(error))
            );

            return undefined;
        }

        const fromEnv = await this.findEnvToken(start);
        if (fromEnv) {
            void window.showWarningMessage(
                DeepnoteCloud.apiTokenOverriddenByEnv(workspace.asRelativePath(fromEnv.envUri))
            );

            return token;
        }

        // Notifications render `[label](command:...)` as runnable links, and this name comes from the Deepnote API.
        const workspaceName = checked.workspaceName?.replace(/\]\(/g, '] (');
        void window.showInformationMessage(
            workspaceName ? DeepnoteCloud.apiTokenSavedForWorkspace(workspaceName) : DeepnoteCloud.apiTokenSaved
        );

        return token;
    }

    private async promptForToken(): Promise<string | undefined> {
        const value = await window.showInputBox({
            password: true,
            ignoreFocusOut: true,
            prompt: DeepnoteCloud.apiTokenPrompt,
            placeHolder: DeepnoteCloud.apiTokenPlaceholder,
            validateInput: (input) =>
                INVALID_TOKEN_CHARACTERS.test(input.trim()) ? DeepnoteCloud.apiTokenInvalidCharacters : undefined
        });

        return value?.trim() || undefined;
    }

    /** The variables of the `.env` in `dir`; `undefined` when it is missing or cannot be read. */
    private async readEnvFile(dir: Uri): Promise<Record<string, string> | undefined> {
        const envPath = getFilePath(Uri.joinPath(dir, ENV_FILE_NAME));
        try {
            const content = await readTextFile(envPath);

            return content === undefined ? undefined : dotenv.parse(content);
        } catch (error) {
            logger.warn(`Could not read ${envPath}`, error);

            return undefined;
        }
    }

    /** The command argument, else the active notebook or file; with none, the workspace folder. Tells the user why not. */
    private async resolveStart(resource?: Uri): Promise<Uri | undefined> {
        const activeNotebook = window.activeNotebookEditor?.notebook.uri;
        const start =
            resource ??
            (activeNotebook && withoutQueryAndFragment(activeNotebook)) ??
            window.activeTextEditor?.document.uri;

        return start?.scheme === 'file' ? start : this.pickWorkspaceFolder();
    }
}
