import { By, InputBox, VSBrowser } from 'vscode-extension-tester';

/**
 * Tries to open the active InputBox/QuickPick, returning `undefined` instead of throwing when none
 * appears within `timeout`. Useful when a command may either open a quick pick or bail with a
 * notification.
 */
export async function tryOpenInputBox(timeout: number): Promise<InputBox | undefined> {
    try {
        return await InputBox.create(timeout);
    } catch (error) {
        console.warn('[deepnote-e2e] open input box:', error);

        return undefined;
    }
}

/**
 * Clicks the "OK" button of the in-window simple file/folder dialog
 * (`files.simpleDialog.enable`). In that dialog Enter navigates *into* a directory rather than
 * accepting it, so clicking OK is the deterministic accept. Returns false if no OK button is found.
 */
export async function clickDialogOkButton(): Promise<boolean> {
    const driver = VSBrowser.instance.driver;
    const buttons = await driver
        .findElements(By.css('.quick-input-widget .monaco-button.monaco-text-button'))
        .catch((error) => {
            console.warn('[deepnote-e2e] find folder dialog buttons:', error);

            return [];
        });

    for (const button of buttons) {
        const text = (
            await button.getText().catch((error) => {
                console.warn('[deepnote-e2e] read folder dialog button text:', error);

                return '';
            })
        ).trim();
        if (text === 'OK') {
            await button.click();

            return true;
        }
    }

    return false;
}
