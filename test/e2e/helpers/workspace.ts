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
 * Opens a file that lives in the currently-open workspace folder via Quick Open ("Go to File..."),
 * matching by file name. Unlike the simple Open File dialog (where Enter does not accept a typed
 * path), Quick Open reliably opens the highlighted match on confirm.
 *
 * Driving the running window directly avoids ExTester's `openResources`, which shells out to
 * `code -r <file>` (reuse-window over IPC) and silently no-ops in a sandboxed/headless instance.
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
 * Opens an absolute folder path as the workspace root via "File: Open Folder...". Opening a folder
 * reloads the VS Code window.
 *
 * In the simple folder dialog (files.simpleDialog.enable), clicking OK navigates one directory level
 * *toward* the typed path rather than accepting it outright; only once the browser is AT the target
 * folder does OK accept it as the workspace. So we open the dialog once, type the path, then click OK
 * repeatedly in the SAME dialog until the pre-open workbench element detaches (reload = accepted).
 *
 * The earlier approach re-opened the dialog on every attempt, which reset navigation to the default
 * directory. That converged for the first folder-open in a session but not for later ones (whose
 * default directory is the previous, now-deleted, workspace) — so the 2nd+ folder open in a
 * multi-suite run failed. Staying in one dialog and re-clicking OK converges regardless of the
 * starting directory.
 */
export async function openFolderViaDialog(folder: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));

    await new Workbench().executeCommand('File: Open Folder...');
    const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
    await dialog.setText(folder);

    // The simple dialog resolves the typed path asynchronously (listing the enclosing directory);
    // wait for that listing and add a short settle before accepting.
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
                    // Stale element reference means the workbench reloaded (folder accepted).
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
