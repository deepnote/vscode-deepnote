import { getWorkspace, type Workspace } from '@deepnote/cloud';
import { findSyncManifestRoot } from '@deepnote/cloud-sync';
import { isUtf8 } from 'buffer';
import dotenv from 'dotenv';
import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import { isDeepStrictEqual } from 'util';
import { commands, extensions, ProgressLocation, Uri, window, workspace } from 'vscode';

import { IExtensionSyncActivationService } from '../../../platform/activation/types';
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
const GITIGNORE_FILE_NAME = '.gitignore';

// Both assignment forms `dotenv.parse` accepts: `KEY=value` and `KEY: value`, with an optional `export `.
const TOKEN_LINE_PATTERN = /^[ \t]*(?:export[ \t]+)?DEEPNOTE_TOKEN(?:[ \t]*=|:[ \t]).*$/;

// What a `.env` line or a shell would split or unquote on, plus control characters: `fetch` rejects a NUL in a header
// with an error that quotes the whole `Authorization` value, token included.
const INVALID_TOKEN_CHARACTERS = /[\s"'#\p{Cc}]/u;
const BYTE_ORDER_MARK = '\uFEFF';

// Minimal shape of the members used from the built-in Git extension, which ships no types.
interface GitRepository {
    checkIgnore?(paths: string[]): Promise<Set<string>>;
}
interface GitExtensionExports {
    getAPI(version: 1): { getRepository(uri: Uri): GitRepository | null };
}

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

/** Throws for a file that is not UTF-8: writing back its lossy decode would replace every such byte with U+FFFD. */
async function readTextFileToRewrite(filePath: string): Promise<string | undefined> {
    const bytes = await readFileBytes(filePath);
    if (bytes && !isUtf8(bytes)) {
        throw new Error(`${filePath} is not valid UTF-8`);
    }

    return bytes?.toString('utf8');
}

function detectLineEnding(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

/** Splits into lines without the terminator of the last one, so a trailing line ending is not a blank line. */
function splitLines(content: string): string[] {
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    return lines;
}

function joinLines(lines: string[], lineEnding: string): string {
    return lines.map((line) => line + lineEnding).join('');
}

function withToken(content: string, token: string): string {
    const assignment = `${TOKEN_ENV_VAR}=${token}`;
    const lines = splitLines(content);
    const first = lines.findIndex((line) => TOKEN_LINE_PATTERN.test(line));
    const result =
        first === -1
            ? [...lines, assignment]
            : lines.flatMap((line, index) => {
                  if (index === first) {
                      return [assignment];
                  }

                  return TOKEN_LINE_PATTERN.test(line) ? [] : [line];
              });

    return joinLines(result, detectLineEnding(content));
}

function withoutToken(content: string): string {
    return joinLines(
        splitLines(content).filter((line) => !TOKEN_LINE_PATTERN.test(line)),
        detectLineEnding(content)
    );
}

function otherVariables(content: string): Record<string, string> {
    const variables = dotenv.parse(content);
    delete variables[TOKEN_ENV_VAR];

    return variables;
}

/**
 * Whether `after` is `before` with only `DEEPNOTE_TOKEN` changed to `token` (absent when `token` is `undefined`), as
 * `dotenv.parse` reads them. The line-based edit cannot tell a multi-line quoted value from separate assignments, so
 * this is what stops it from corrupting another variable.
 */
function isSafeEnvEdit(before: string, after: string, token: string | undefined): boolean {
    return (
        isDeepStrictEqual(otherVariables(before), otherVariables(after)) && dotenv.parse(after)[TOKEN_ENV_VAR] === token
    );
}

@injectable()
export class DeepnoteApiTokenService implements IDeepnoteApiTokenService, IExtensionSyncActivationService {
    constructor(@inject(IExtensionContext) private readonly extensionContext: IExtensionContext) {}

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

        for (const dir of await this.getLookupDirs(resource)) {
            const token = (await this.readEnvFile(dir))?.[TOKEN_ENV_VAR]?.trim();
            if (token) {
                return token;
            }
        }

        return undefined;
    }

    /** Seam for tests, which never reach the network. */
    protected fetchWorkspace(baseUrl: string, token: string): Promise<Workspace | undefined> {
        return getWorkspace(baseUrl, token);
    }

    /** `undefined` means the Git extension gave no answer. Never throws. */
    protected async isIgnoredByGit(envUri: Uri): Promise<boolean | undefined> {
        try {
            const extension = extensions.getExtension<GitExtensionExports>('vscode.git');
            if (!extension) {
                return undefined;
            }

            const exports = extension.isActive ? extension.exports : await extension.activate();
            const repository = exports.getAPI(1).getRepository(envUri);
            if (!repository || typeof repository.checkIgnore !== 'function') {
                return undefined;
            }

            return (await repository.checkIgnore([getFilePath(envUri)])).size > 0;
        } catch (error) {
            logger.debug('The Git extension could not tell whether the .env file is ignored', error);

            return undefined;
        }
    }

    private async addToGitignore(folder: Uri): Promise<void> {
        const gitignorePath = getFilePath(Uri.joinPath(folder, GITIGNORE_FILE_NAME));
        // git reads .gitignore as bytes, and latin1 maps every byte to one character and back, so a file in any
        // encoding gets its new line without its other bytes being rewritten.
        const before = (await readFileBytes(gitignorePath))?.toString('latin1') ?? '';

        await fs.promises.writeFile(
            gitignorePath,
            joinLines([...splitLines(before), ENV_FILE_NAME], detectLineEnding(before)),
            'latin1'
        );
    }

    /** Never throws. */
    private async checkEnvFileInGit(envUri: Uri): Promise<void> {
        try {
            if ((await this.isIgnoredByGit(envUri)) !== false) {
                return;
            }

            const choice = await window.showWarningMessage(
                DeepnoteCloud.envNotIgnored(workspace.asRelativePath(envUri)),
                { modal: true },
                DeepnoteCloud.addToGitignore
            );
            if (choice === DeepnoteCloud.addToGitignore) {
                await this.addToGitignore(dirname(envUri));
            }
        } catch (error) {
            logger.warn('Could not add .env to .gitignore', error);
        }
    }

    /** Resolves `undefined` after telling the user why the token was not accepted. */
    private async checkToken(start: Uri, token: string): Promise<{ workspaceName?: string } | undefined> {
        try {
            const deepnoteWorkspace = await window.withProgress(
                { location: ProgressLocation.Notification, title: DeepnoteCloud.checkingApiToken },
                () => this.fetchWorkspace(getApiEndpoint(start), token)
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

        const envFiles = await this.findAssigningEnvFiles(await this.getLookupDirs(start));
        if (envFiles.length === 0) {
            void window.showInformationMessage(DeepnoteCloud.noApiTokenFound);

            return;
        }

        let cleared = false;
        for (const envUri of envFiles) {
            cleared = (await this.editEnvFile(envUri, withoutToken, undefined)) || cleared;
        }

        if (cleared) {
            void window.showInformationMessage(DeepnoteCloud.apiTokenCleared);
        }
    }

    /**
     * Rewrites `envUri` through `edit`, creating it when missing. Writes nothing and tells the user when the edit is
     * not safe or the file cannot be read or written.
     */
    private async editEnvFile(
        envUri: Uri,
        edit: (content: string) => string,
        expectedToken: string | undefined
    ): Promise<boolean> {
        const envPath = getFilePath(envUri);
        try {
            const before = (await readTextFileToRewrite(envPath)) ?? '';
            // dotenv reads past a byte order mark, TOKEN_LINE_PATTERN does not, so edit around it.
            const bom = before.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
            const after = bom + edit(before.slice(bom.length));
            if (isSafeEnvEdit(before, after, expectedToken)) {
                await fs.promises.writeFile(envPath, after);

                return true;
            }
        } catch (error) {
            logger.warn(`Could not update ${envPath}`, error);
        }

        void window.showErrorMessage(DeepnoteCloud.envEditFailed(workspace.asRelativePath(envUri)));

        return false;
    }

    private ensureTrusted(): boolean {
        if (workspace.isTrusted) {
            return true;
        }

        void window.showErrorMessage(DeepnoteCloud.workspaceNotTrusted);

        return false;
    }

    /** The `.env` files among `dirs` that assign `DEEPNOTE_TOKEN`, even to an empty value, nearest first. */
    private async findAssigningEnvFiles(dirs: Uri[]): Promise<Uri[]> {
        const envFiles: Uri[] = [];
        for (const dir of dirs) {
            if ((await this.readEnvFile(dir))?.[TOKEN_ENV_VAR] !== undefined) {
                envFiles.push(Uri.joinPath(dir, ENV_FILE_NAME));
            }
        }

        return envFiles;
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

    /** The folders to search for a `.env`, nearest first, from the folder of `resource` up to the folder it is rooted in. */
    private async getLookupDirs(resource: Uri): Promise<Uri[]> {
        const start = withoutQueryAndFragment(resource);
        const startFolder = await getStartFolder(start);
        const stopFolder = removeTrailingPathSeparator(await this.getStopFolder(start, startFolder));

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

    /** The higher of the workspace folder root and the sync root, else `startFolder`. */
    private async getStopFolder(start: Uri, startFolder: Uri): Promise<Uri> {
        const workspaceFolder = workspace.getWorkspaceFolder(start)?.uri;
        const syncRoot = await this.findSyncRoot(startFolder);
        if (workspaceFolder && syncRoot) {
            return extUriBiasedIgnorePathCase.isEqualOrParent(syncRoot, workspaceFolder) ? workspaceFolder : syncRoot;
        }

        return workspaceFolder ?? syncRoot ?? startFolder;
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

        const target = await this.resolveTargetFolder(start);
        const token = await this.promptForToken();
        if (!token) {
            return undefined;
        }

        const checked = await this.checkToken(start, token);
        if (!checked) {
            return undefined;
        }

        const [assigningEnvFile] = await this.findAssigningEnvFiles(await this.getLookupDirs(start));
        const envUri = assigningEnvFile ?? Uri.joinPath(target, ENV_FILE_NAME);
        if (!(await this.editEnvFile(envUri, (content) => withToken(content, token), token))) {
            return undefined;
        }

        await this.checkEnvFileInGit(envUri);

        // Notifications render `[label](command:...)` as runnable links, and this name comes from the Deepnote API.
        const workspaceName = checked.workspaceName?.replace(/\]\(/g, '] (');
        const envPath = workspace.asRelativePath(envUri);
        void window.showInformationMessage(
            workspaceName
                ? DeepnoteCloud.apiTokenSavedForWorkspace(workspaceName, envPath)
                : DeepnoteCloud.apiTokenSaved(envPath)
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

    private async resolveTargetFolder(start: Uri): Promise<Uri> {
        const cleared = withoutQueryAndFragment(start);
        const startFolder = await getStartFolder(cleared);

        return (await this.findSyncRoot(startFolder)) ?? workspace.getWorkspaceFolder(cleared)?.uri ?? startFolder;
    }
}
