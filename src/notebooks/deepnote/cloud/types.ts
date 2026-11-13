import { Uri } from 'vscode';

export const IDeepnoteApiTokenService = Symbol('IDeepnoteApiTokenService');
export interface IDeepnoteApiTokenService {
    /**
     * The trimmed `DEEPNOTE_TOKEN` from the nearest `.env` on the lookup path of `resource` that defines a non-empty
     * value. Otherwise the token saved with Set API Token for the Deepnote API host of `resource`. `undefined` when
     * neither exists, `resource` is not a local file, or the workspace is not trusted. Never prompts.
     *
     * The lookup path runs from `resource` if it is a folder, else from its folder, up to the nearest folder holding a
     * sync manifest. Without one it is only that first folder, so a folder reads the same `.env` before and after its
     * first sync.
     */
    getToken(resource: Uri): Promise<string | undefined>;

    /**
     * {@link getToken}, else asks the user for a token, checks it with Deepnote and saves it to VS Code SecretStorage.
     * `undefined` means the user cancelled, `resource` is not a local file, the workspace is not trusted, or the `.env`
     * token has a character an API key cannot contain; the user has already been told.
     */
    getOrPromptToken(resource: Uri): Promise<string | undefined>;
}

export const IDeepnoteCloudOperationLock = Symbol('IDeepnoteCloudOperationLock');
export interface IDeepnoteCloudOperationLock {
    /**
     * Runs `run` as the one sync, or publish into a synced folder, in this window, and resolves or rejects as it does.
     * The lock is free again by the time the returned promise settles. When one is already running, calls `onBusy`
     * instead of `run` and resolves to `undefined`.
     */
    tryRunExclusive<T>(run: () => Promise<T>, onBusy?: () => void): Promise<T | undefined>;
}

/** The argument of `deepnote.syncWithDeepnoteCloud` that syncs `root` without asking for a folder. */
export interface SyncWithDeepnoteCloudTarget {
    root: Uri;
    /** Also sync each project's working files, such as app files. */
    allFiles: boolean;
}
