import { By, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    DIALOG_RESOLVE_DELAY,
    FOLDER_OK_RETRY_DELAY,
    FOLDER_OPEN_TIMEOUT,
    QUICK_PICK_TIMEOUT,
    RELOAD_POLL_TIMEOUT
} from './constants';
import { clickDialogOkButton } from './quickInput';

/**
 * Opens a workspace file by name via Quick Open ("Go to File..."), which reliably opens the
 * highlighted match on confirm. Driving the running window directly avoids ExTester's
 * `openResources`, which shells out to `code -r` and silently no-ops when headless.
 */
export async function openWorkspaceFile(fileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await new Workbench().executeCommand('Go to File...');

    const quickOpen = await InputBox.create(QUICK_PICK_TIMEOUT);
    await quickOpen.setText(fileName);
    await driver.wait(
        async () => (await quickOpen.getQuickPicks()).length > 0,
        QUICK_PICK_TIMEOUT,
        `"${fileName}" did not appear in Quick Open`
    );
    await quickOpen.confirm();
}

/**
 * Opens an absolute folder path as the workspace root (reloads the window). In the simple folder
 * dialog, clicking OK navigates one level toward the typed path rather than accepting it, so we type
 * the path once and re-click OK in the SAME dialog until the pre-open workbench detaches (= accepted).
 * Re-opening the dialog per attempt instead would reset navigation and fail on 2nd+ opens.
 */
export async function openFolderViaDialog(folder: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));

    await new Workbench().executeCommand('File: Open Folder...');
    const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
    await dialog.setText(folder);

    // The simple dialog resolves the typed path asynchronously; wait for the listing, then settle.
    await driver
        .wait(async () => (await dialog.getQuickPicks()).length > 0, QUICK_PICK_TIMEOUT, 'dialog did not resolve path')
        .catch((error) => {
            console.warn('[deepnote-e2e] wait for folder dialog path listing:', error);
        });
    await driver.sleep(DIALOG_RESOLVE_DELAY);

    const deadline = Date.now() + FOLDER_OPEN_TIMEOUT;
    while (Date.now() < deadline) {
        await clickDialogOkButton();

        const reloaded = await driver
            .wait(async () => {
                try {
                    await previousWorkbench.getTagName();

                    return false;
                } catch {
                    // Stale element = workbench reloaded (folder accepted).
                    return true;
                }
            }, RELOAD_POLL_TIMEOUT)
            .then(() => true)
            .catch(() => false);
        if (reloaded) {
            return;
        }

        await driver.sleep(FOLDER_OK_RETRY_DELAY);
    }

    await new InputBox().cancel().catch((error) => {
        console.warn('[deepnote-e2e] cancel folder dialog:', error);
    });

    throw new Error(`Failed to open folder "${folder}": the dialog never accepted the target`);
}
