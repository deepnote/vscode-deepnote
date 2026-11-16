import { InputBox, Workbench } from 'vscode-extension-tester';

import { QUICK_PICK_TIMEOUT, WORKBENCH_TIMEOUT } from './constants';
import { dismissAllNotifications, waitForNotification } from './notifications';

export const API_TOKEN = 'e2e_mock_token';

/**
 * Saves {@link API_TOKEN} with "Deepnote: Set API Token". Resolves with the confirmation message, or throws with the
 * error one.
 */
export async function setApiToken(): Promise<string> {
    await dismissAllNotifications();
    await new Workbench().executeCommand('Deepnote: Set API Token');
    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await input.setText(API_TOKEN);
    await input.confirm();

    const outcome = await waitForNotification(
        /^(Signed in to the Deepnote workspace|Deepnote API token saved|Deepnote rejected|Could not check|Could not save)/,
        WORKBENCH_TIMEOUT,
        true
    );
    const message = (await outcome?.getMessage()) ?? '';
    if (/^(Deepnote rejected|Could not)/.test(message)) {
        throw new Error(message);
    }

    return message;
}
