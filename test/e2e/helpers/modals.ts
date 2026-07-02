import { By, VSBrowser } from 'vscode-extension-tester';

import { WORKBENCH_TIMEOUT } from './constants';

/**
 * Confirms a VS Code `{modal:true}` message dialog by clicking the button whose text matches `label`
 * exactly. VS Code renders these dialogs in the DOM (the E2E `settings.json` sets
 * `"window.dialogStyle": "custom"`), but ExTester's `ModalDialog` page object is unreliable at
 * attaching to them — so this drives the raw `.monaco-dialog-box` directly. When `messageIncludes` is
 * given, it first waits for the dialog whose text contains that string, so the intended dialog is
 * targeted and the exact-text button match can't hit a same-named control elsewhere (e.g. a tree
 * "Delete …" context-menu item).
 */
export async function confirmModalDialog(label: string, options?: { messageIncludes?: string }): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const messageIncludes = options?.messageIncludes;

    await driver.wait(
        async () => {
            for (const box of await driver.findElements(By.css('.monaco-dialog-box')).catch(() => [])) {
                const text = await box.getText().catch(() => '');
                if (!messageIncludes || text.includes(messageIncludes)) {
                    return true;
                }
            }

            return false;
        },
        WORKBENCH_TIMEOUT,
        `modal dialog${messageIncludes ? ` containing "${messageIncludes}"` : ''} did not appear`
    );

    const button = await driver.wait(
        async () => {
            const selector = '.monaco-dialog-box .dialog-buttons .monaco-button, .monaco-dialog-box .monaco-button';
            for (const element of await driver.findElements(By.css(selector)).catch(() => [])) {
                if ((await element.getText().catch(() => '')).trim() === label) {
                    return element;
                }
            }

            return undefined;
        },
        WORKBENCH_TIMEOUT,
        `modal dialog button "${label}" did not appear`
    );
    if (!button) {
        throw new Error(`modal dialog button "${label}" not found`);
    }

    // Move the mouse onto the button and click it.
    await driver.actions().move({ origin: button }).click().perform();
}
