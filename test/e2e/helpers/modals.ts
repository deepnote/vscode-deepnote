import { By, VSBrowser, WebElement } from 'vscode-extension-tester';

import { WORKBENCH_TIMEOUT } from './constants';

/**
 * Confirms a `{modal:true}` dialog by clicking the button matching `label`, driving the raw
 * `.monaco-dialog-box` (ExTester's `ModalDialog` attaches unreliably); `messageIncludes` disambiguates.
 */
export async function confirmModalDialog(
    label: string,
    options?: { messageIncludes?: string; onVisible?: (dialog: WebElement) => Promise<void> }
): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const messageIncludes = options?.messageIncludes;

    const dialog = await driver.wait(
        async () => {
            for (const box of await driver.findElements(By.css('.monaco-dialog-box')).catch(() => [])) {
                const text = await box.getText().catch(() => '');
                if (!messageIncludes || text.includes(messageIncludes)) {
                    return box;
                }
            }

            return undefined;
        },
        WORKBENCH_TIMEOUT,
        `modal dialog${messageIncludes ? ` containing "${messageIncludes}"` : ''} did not appear`
    );
    if (!dialog) {
        throw new Error(`modal dialog${messageIncludes ? ` containing "${messageIncludes}"` : ''} not found`);
    }

    // Runs while the dialog is still up — the only chance to capture or inspect it.
    await options?.onVisible?.(dialog);

    // Scoped to the matched dialog: an unscoped query would discard what `messageIncludes` resolved.
    const button = await driver.wait(
        async () => {
            const selector = '.dialog-buttons .monaco-button, .monaco-button';
            for (const element of await dialog.findElements(By.css(selector)).catch(() => [])) {
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

    await driver.actions().move({ origin: button }).click().perform();
}
