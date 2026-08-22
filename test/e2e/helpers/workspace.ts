import { By, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    DIALOG_RESOLVE_DELAY,
    FOLDER_OK_RETRY_DELAY,
    FOLDER_OPEN_TIMEOUT,
    QUICK_PICK_TIMEOUT,
    RELOAD_POLL_TIMEOUT,
    WORKBENCH_TIMEOUT
} from './constants';
import { fixturesWorkspaceRoot } from './fixtures';
import { clickDialogOkButton } from './quickInput';

// Whether the shared fixtures root has been opened yet. Tracked here rather than opened from a Mocha
// root hook: ExTester's runner does not fire `mochaHooks.beforeAll`, so a root hook silently never
// runs and every suite ends up with no workspace at all.
let fixturesRootOpened = false;

// Exact palette labels (category + title) the way `Workbench.executeCommand` matches them.
const CLOSE_ALL_EDITORS_COMMAND = 'View: Close All Editors';
const RELOAD_WINDOW_COMMAND = 'Developer: Reload Window';

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
 * Opens an absolute folder path as the workspace root (reloads the window). In the simple folder
 * dialog, clicking OK navigates one level toward the typed path rather than accepting it, so we type
 * the path once and re-click OK in the SAME dialog until the pre-open workbench detaches (= accepted).
 * Re-opening the dialog per attempt instead would reset navigation and fail on 2nd+ opens.
 */
async function openFolderViaDialog(folder: string): Promise<void> {
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

/**
 * Puts the window into the state a suite expects: the shared fixtures workspace open and nothing left
 * over from the suite before it. Every suite calls this in `before()`.
 *
 * The folder is opened once; after that each suite gets a window reload. Reloading restarts the
 * extension host, which is the only thing that reliably clears everything a previous suite can leave
 * behind — open editors, the Deepnote Explorer's cached project groups, cached project data keyed by
 * id, and the Python extension's interpreter discovery. Clearing those individually was possible but
 * open-ended; every fix uncovered another.
 *
 * The reload is not what made the old per-suite setup slow. That was `File: Open Folder...`, whose
 * simple dialog navigates one level per OK click, so opening a path meant re-clicking for up to
 * FOLDER_OPEN_TIMEOUT. Keeping one workspace and reloading inside it drops that cost while keeping
 * the isolation.
 */
export async function enterFixturesWorkspace(): Promise<void> {
    if (!fixturesRootOpened) {
        await openFolderViaDialog(fixturesWorkspaceRoot());
        fixturesRootOpened = true;

        return;
    }

    const driver = VSBrowser.instance.driver;

    // Close before reloading: a reload restores whatever was open, so a suite that renamed or deleted
    // notebooks would hand its dead tabs straight to the next one. Driven through the palette rather
    // than `EditorView.closeAllEditors`, which clicks each tab's close button and fails on notebook
    // tabs with ElementNotInteractableError.
    await new Workbench().executeCommand(CLOSE_ALL_EDITORS_COMMAND);

    const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));
    await new Workbench().executeCommand(RELOAD_WINDOW_COMMAND);

    // Same staleness probe openFolderViaDialog uses: the old workbench detaching is the signal that
    // the reload actually started, rather than a fixed sleep.
    await driver.wait(async () => {
        try {
            await previousWorkbench.getTagName();

            return false;
        } catch {
            return true;
        }
    }, WORKBENCH_TIMEOUT);

    await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
}
