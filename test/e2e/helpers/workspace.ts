import { By, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import { DIALOG_RESOLVE_DELAY, FOLDER_OPEN_ATTEMPTS, FOLDER_RELOAD_TIMEOUT, QUICK_PICK_TIMEOUT } from './constants';
import { catchAndLog, logCaughtError } from './logging';
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
 * reloads the VS Code window. In the simple folder dialog, Enter navigates *into* a directory rather
 * than accepting it as the workspace — the deterministic accept is the dialog's "OK" button — so we
 * type the path, click OK, and wait for the pre-reload workbench element to detach (reload started).
 * We retry the whole interaction defensively. The caller then waits for the new workbench to mount.
 */
export async function openFolderViaDialog(folder: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    for (let attempt = 1; attempt <= FOLDER_OPEN_ATTEMPTS; attempt++) {
        const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));

        await new Workbench().executeCommand('File: Open Folder...');
        const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
        await dialog.setText(folder);

        // The simple dialog resolves the typed path asynchronously (listing the enclosing
        // directory); wait for that listing and add a short settle before accepting.
        await driver
            .wait(
                async () => (await dialog.getQuickPicks()).length > 0,
                QUICK_PICK_TIMEOUT,
                'dialog did not resolve path'
            )
            .catch(catchAndLog('wait for folder dialog path listing', undefined));
        await driver.sleep(DIALOG_RESOLVE_DELAY);

        const accepted = await clickDialogOkButton();
        if (!accepted) {
            await new InputBox().cancel().catch(catchAndLog('cancel folder dialog', undefined));
            continue;
        }

        const reloaded = await driver
            .wait(async () => {
                try {
                    await previousWorkbench.getTagName();

                    return false;
                } catch (error) {
                    // Stale element reference means the workbench reloaded.
                    logCaughtError('detect workbench reload via stale element', error, true);

                    return true;
                }
            }, FOLDER_RELOAD_TIMEOUT)
            .then(() => true)
            .catch(catchAndLog('wait for workbench reload', false));
        if (reloaded) {
            return;
        }

        // The folder did not open this time; dismiss any lingering dialog and retry.
        await new InputBox().cancel().catch(catchAndLog('cancel lingering folder dialog', undefined));
    }

    throw new Error(`Failed to open folder "${folder}" after ${FOLDER_OPEN_ATTEMPTS} attempts`);
}
