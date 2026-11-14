import { env, Uri, window } from 'vscode';

import { DeepnoteCloud } from '../../../platform/common/utils/localize';

export const COPIED_MESSAGE_TIMEOUT_MS = 3000;

/** Shows `message` with "Open", which opens `url` in the browser, and "Copy", which copies it to the clipboard. */
export async function showPublishedAppUrl(message: string, url: string): Promise<void> {
    const choice = await window.showInformationMessage(message, DeepnoteCloud.open, DeepnoteCloud.copy);
    if (choice === DeepnoteCloud.open) {
        await env.openExternal(Uri.parse(url));
    } else if (choice === DeepnoteCloud.copy) {
        await env.clipboard.writeText(url);
        window.setStatusBarMessage(DeepnoteCloud.copiedToClipboard, COPIED_MESSAGE_TIMEOUT_MS);
    }
}
