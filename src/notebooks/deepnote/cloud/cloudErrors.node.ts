import { ApiError } from '@deepnote/cloud-sync';
import { commands, Uri, window } from 'vscode';

import { Commands } from '../../../platform/common/constants';
import { DeepnoteCloud } from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';

const UNAUTHORIZED_STATUS = 401;

/**
 * Whether Deepnote answered 401, meaning the token is missing, invalid or revoked. A 403 is not matched: the token was
 * accepted, but the request is not allowed.
 */
export function isRejectedTokenError(error: unknown): boolean {
    return error instanceof ApiError && error.statusCode === UNAUTHORIZED_STATUS;
}

/**
 * Logs a failed Deepnote Cloud call and tells the user. A rejected token offers "Set API Token" for `resource` and
 * resolves once that prompt is dismissed; any other failure shows `<message>: <detail>` and resolves immediately.
 */
export async function showCloudError(message: string, error: unknown, resource?: Uri): Promise<void> {
    logger.error(message, error);

    if (isRejectedTokenError(error)) {
        const choice = await window.showErrorMessage(
            DeepnoteCloud.apiTokenRejectedForRequest,
            DeepnoteCloud.setApiToken
        );
        if (choice === DeepnoteCloud.setApiToken) {
            await commands.executeCommand(Commands.SetApiToken, resource);
        }

        return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    void window.showErrorMessage(DeepnoteCloud.errorWithDetail(message, detail));
}
