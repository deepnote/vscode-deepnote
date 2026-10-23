import { Uri } from 'vscode';

export const IDeepnoteApiTokenService = Symbol('IDeepnoteApiTokenService');
export interface IDeepnoteApiTokenService {
    /**
     * The trimmed `DEEPNOTE_TOKEN` from the nearest `.env` on the lookup path of `resource` that defines a non-empty
     * value. `undefined` when no `.env` defines it, `resource` is not a local file, or the workspace is not trusted.
     * Never prompts.
     */
    getToken(resource: Uri): Promise<string | undefined>;

    /**
     * {@link getToken}, else asks the user for a token, checks it with Deepnote and saves it to `.env`. `undefined`
     * means the user cancelled, `resource` is not a local file, or the workspace is not trusted; the user has already
     * been told.
     */
    getOrPromptToken(resource: Uri): Promise<string | undefined>;
}
