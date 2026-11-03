import { Uri } from 'vscode';

export const IDeepnoteApiTokenService = Symbol('IDeepnoteApiTokenService');
export interface IDeepnoteApiTokenService {
    /**
     * The trimmed `DEEPNOTE_TOKEN` from the nearest `.env` on the lookup path of `resource` that defines a non-empty
     * value. Otherwise the token saved with Set API Token for the Deepnote API host of `resource`. `undefined` when
     * neither exists, `resource` is not a local file, or the workspace is not trusted. Never prompts.
     *
     * The lookup path runs from `resource` if it is a folder, else from its folder, up to `syncRoot` when given, else up
     * to the nearest folder holding a sync manifest, else up to the workspace folder.
     */
    getToken(resource: Uri, syncRoot?: Uri): Promise<string | undefined>;

    /**
     * {@link getToken}, else asks the user for a token, checks it with Deepnote and saves it to VS Code SecretStorage.
     * `undefined` means the user cancelled, `resource` is not a local file, the workspace is not trusted, or the `.env`
     * token has a character an API key cannot contain; the user has already been told.
     */
    getOrPromptToken(resource: Uri, syncRoot?: Uri): Promise<string | undefined>;
}
