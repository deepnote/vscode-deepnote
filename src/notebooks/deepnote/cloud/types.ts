import { Uri } from 'vscode';

export const IDeepnoteApiTokenService = Symbol('IDeepnoteApiTokenService');
export interface IDeepnoteApiTokenService {
    /**
     * The trimmed `DEEPNOTE_TOKEN` from the nearest `.env` on the lookup path of `resource` that defines a non-empty
     * value. Otherwise the token saved with Set API Token for the Deepnote API host of `resource`. `undefined` when
     * neither exists, `resource` is not a local file, or the workspace is not trusted. Never prompts.
     */
    getToken(resource: Uri): Promise<string | undefined>;

    /**
     * {@link getToken}, else asks the user for a token, checks it with Deepnote and saves it to VS Code SecretStorage.
     * `undefined` means the user cancelled, `resource` is not a local file, or the workspace is not trusted; the user
     * has already been told.
     */
    getOrPromptToken(resource: Uri): Promise<string | undefined>;
}
