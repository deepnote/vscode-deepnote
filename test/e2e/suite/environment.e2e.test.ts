/**
 * E2E (ExTester): splitting a multi-notebook file that had a selected environment migrates that
 * environment onto every split child. Signal: the `.vscode/deepnote.json` sidecar (projectId ->
 * environmentId). We select an env for the original, accept the split, DELETE the sidecar, then open
 * a split child — the sidecar is regenerated solely from the child's migrated mapping. Requires a
 * Python kernel.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ActivityBar,
    By,
    EditorView,
    InputBox,
    ModalDialog,
    SideBarView,
    VSBrowser,
    WebView,
    Workbench,
    type ViewItem
} from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    KERNEL_CONNECT_TIMEOUT,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectDeepnoteContextMenu,
    selectEnvironmentForNotebook,
    waitForNotification
} from '../helpers';

const FIXTURE = 'sales-analytics.deepnote';
const CHILD = 'sales-analytics-overview.deepnote';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENV_NAME = 'E2E Hello Env'; // shared env so CI provisions one venv
const SPLIT_PROMPT = /contains multiple notebooks/i;
const SPLIT_ACTION = 'Split into separate files';
const SPLIT_DONE = /Split into \d+ files\./i;

// How long to poll the filesystem for the regenerated sidecar after opening the child.
const SIDECAR_REGEN_TIMEOUT = 30_000;
const SIDECAR_POLL_INTERVAL = 1_000;

// Short window to catch the split prompt inline (before falling back to a window reload).
const INLINE_PROMPT_TIMEOUT = 15_000;
// Settle after the workbench reports ready following a reload, before driving the UI again.
const RELOAD_SETTLE = 3_000;

/**
 * Reloads the VS Code window and waits until it is genuinely interactive again. Capturing the
 * pre-reload `.monaco-workbench` element and waiting for it to go stale (as the folder-open helper
 * does) avoids racing `EditorView`/quick-open against a window that is still tearing down — the race
 * that otherwise throws `NoSuchElementError: .monaco-workbench`.
 */
async function reloadWindow(): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));

    await new Workbench().executeCommand('Developer: Reload Window');

    await driver
        .wait(
            async () => {
                try {
                    await previousWorkbench.getTagName();

                    return false;
                } catch {
                    // Stale element reference means the old workbench detached (reload started).
                    return true;
                }
            },
            WORKBENCH_TIMEOUT,
            'window did not begin reloading'
        )
        .catch(() => undefined);

    await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
    await driver.sleep(RELOAD_SETTLE);
}

describe('Deepnote — splitting a file migrates its selected environment onto every child', function () {
    this.timeout(SUITE_TIMEOUT);
    this.retries(0); // destructive (retires the original to .legacy); not idempotent

    let cleanupTempDir: (() => void) | undefined;
    let sidecarEnvId: string | undefined;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);
        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;
        const tempDir = copy.tempDir;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await createEnvironment(ENV_NAME);

        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );

        // Select env WITHOUT dismissing the split prompt (inline; the split prompt is a bottom-right
        // toast, the env quick-pick is centre — they coexist). Replicates selectEnvironmentForNotebook
        // minus its dismissAllNotifications() call, which would otherwise kill the split prompt.
        await new EditorView().openEditor(FIXTURE);
        await new Workbench().executeCommand('Deepnote: Select Environment for Notebook');
        const pick = await InputBox.create(QUICK_PICK_TIMEOUT);
        await pick.setText(ENV_NAME);
        await driver.wait(async () => (await pick.getQuickPicks()).length > 0, QUICK_PICK_TIMEOUT, 'env pick empty');
        await pick.confirm();
        await waitForNotification(/switched successfully/i, KERNEL_CONNECT_TIMEOUT, false);
        await screenshot('env-selected');

        // Accept the split. Prefer the still-open prompt; but selecting the environment rebuilds the
        // kernel (a multi-minute wait above) during which the warning toast can auto-collapse into the
        // notification centre where `getNotifications()` no longer sees it. If it's gone, reload the
        // window: that clears the in-memory prompted-once guard, so reopening the fixture re-raises the
        // split prompt. The env selection persists in workspace state across the reload, so reopening
        // does NOT re-prompt for an environment — it just re-raises the split prompt.
        let prompt = await waitForNotification(SPLIT_PROMPT, INLINE_PROMPT_TIMEOUT, false);
        if (!prompt) {
            console.log('[G1] split prompt not visible inline after env-select; using reload path');
            await reloadWindow();
            await openWorkspaceFile(FIXTURE);
            await driver.wait(
                async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(FIXTURE)),
                WORKBENCH_TIMEOUT,
                `${FIXTURE} did not reopen after reload`
            );
            prompt = await waitForNotification(SPLIT_PROMPT, WORKBENCH_TIMEOUT, true);
        }
        await screenshot('split-prompt');

        await prompt!.takeAction(SPLIT_ACTION);
        await waitForNotification(SPLIT_DONE, WORKBENCH_TIMEOUT, true);
        await driver.sleep(2500);
        await screenshot('split-done');

        // Delete the sidecar so only a child's migrated mapping can rewrite it (proves migration, not
        // a stale pre-split entry).
        const sidecarPath = path.join(tempDir, '.vscode', 'deepnote.json');
        fs.rmSync(sidecarPath, { force: true });

        // Open a split child — its migrated env mapping regenerates the sidecar on the open event.
        await new EditorView().closeAllEditors().catch(() => undefined);
        await openWorkspaceFile(CHILD);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(CHILD)),
            WORKBENCH_TIMEOUT,
            `${CHILD} did not open`
        );

        const deadline = Date.now() + SIDECAR_REGEN_TIMEOUT;
        while (Date.now() < deadline) {
            if (fs.existsSync(sidecarPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
                    const id = parsed?.mappings?.[PROJECT_ID]?.environmentId;
                    if (typeof id === 'string' && id.length > 0) {
                        sidecarEnvId = id;
                        break;
                    }
                } catch {
                    /* mid-write */
                }
            }
            await driver.sleep(SIDECAR_POLL_INTERVAL);
        }

        // Diagnostics to aid triage if the sidecar never regenerated.
        if (!sidecarEnvId) {
            const vscodeDir = path.join(tempDir, '.vscode');
            const listing = fs.existsSync(vscodeDir) ? fs.readdirSync(vscodeDir) : '(.vscode missing)';
            console.log('[G1] .vscode listing after opening child:', JSON.stringify(listing));
            if (fs.existsSync(sidecarPath)) {
                console.log('[G1] sidecar contents:', fs.readFileSync(sidecarPath, 'utf8'));
            }
        }
        console.log('[G1] sidecarEnvId=', JSON.stringify(sidecarEnvId));
        await screenshot('sidecar-regenerated');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (e) {
            console.warn('[env-g1] cleanup:', e);
        }
    });

    it('regenerates the env sidecar for the project from a split child (env migrated)', function () {
        expect(sidecarEnvId, 'migrated env id in .vscode/deepnote.json').to.be.a('string').and.not.equal('');
    });
});

/**
 * The Deepnote server starter writes one PID lock file per running kernel/toolkit server at
 * `os.tmpdir()/vscode-deepnote-locks/server-<pid>.json`, deleting it (and killing the process,
 * SIGTERM->SIGKILL) when the server stops — including when an environment is deleted. The test's Node
 * context shares `os.tmpdir()` with the extension host (no TMPDIR override in the E2E setup), so the
 * lock dir is directly readable here. This is the observable, cross-platform signal a stopped
 * out-of-process server otherwise lacks.
 */
const LOCK_DIR = path.join(os.tmpdir(), 'vscode-deepnote-locks');

// A dedicated env name so deleting it never disturbs the shared `E2E Hello Env` other suites reuse.
const DELETE_ENV_NAME = 'E2E Delete Env';
// Single-notebook fixture (notebook "Overview", cell `print("overview")`).
const G2_FIXTURE = 'marketing-overview.deepnote';

// How long to wait, after the first run, for THIS server's fresh PID lock file to appear.
const PID_APPEAR_TIMEOUT = 15_000;
// Settle after closing the tab before checking the server is still alive.
const CLOSE_SETTLE = 2_500;
// How long to wait, after the env is deleted, for the closed notebook's server to actually stop.
const STOP_AFTER_DELETE_TIMEOUT = 30_000;

/** PIDs of every currently-tracked running server (parsed from the lock dir). */
function serverPids(): number[] {
    if (!fs.existsSync(LOCK_DIR)) {
        return [];
    }

    return fs
        .readdirSync(LOCK_DIR)
        .map((file) => /^server-(\d+)\.json$/.exec(file))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => Number(match[1]));
}

/**
 * Cross-platform liveness check. `process.kill(pid, 0)` sends no signal but performs the same
 * existence/permission checks as a real kill: it throws `ESRCH` when the process is gone and `EPERM`
 * when it exists but is owned by another user — so `EPERM` counts as alive.
 */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

/** Opens the Deepnote view container and returns its "Environments" tree section. */
async function getDeepnoteEnvironmentsSection() {
    const control = await new ActivityBar().getViewControl('Deepnote');
    await control?.openView();
    await VSBrowser.instance.driver.sleep(1200);

    const content = new SideBarView().getContent();
    const named = await content.getSection('Environments').catch(() => undefined);
    if (named) {
        return named;
    }

    // Fallback: the environments tree is the second Deepnote section (Explorer is the first).
    const sections = await content.getSections();

    return sections[1] ?? sections[0];
}

/** Finds an environment row in the Environments tree by its label (which is the environment name). */
async function findEnvironmentItem(
    section: Awaited<ReturnType<typeof getDeepnoteEnvironmentsSection>>,
    name: string
): Promise<ViewItem | undefined> {
    for (const item of await section.getVisibleItems().catch(() => [] as ViewItem[])) {
        const label = await (item as unknown as { getLabel(): Promise<string> }).getLabel().catch(() => '');
        if (label.trim() === name) {
            return item;
        }
    }

    return undefined;
}

// The custom modal ("window.dialogStyle": "custom") is DOM-rendered but ExTester's `ModalDialog`
// page object often fails to resolve its base element for these confirmation dialogs, so cap the
// ModalDialog attempt briefly and rely on the raw-DOM path (which is proven to work here).
const MODAL_ATTEMPT_TIMEOUT = 10_000;

/**
 * Confirms the `{modal:true}` delete-environment dialog by clicking its `Delete` button. Tries
 * ExTester's `ModalDialog` first (briefly), then falls back to a raw-DOM click on the custom dialog's
 * button. Both paths verify the dialog text names the environment before clicking, and the fallback
 * scopes to `.monaco-dialog-box` and matches the button text EXACTLY as `Delete` — so it can never
 * click the tree's "Delete Environment" context-menu item.
 */
async function confirmDeleteModal(): Promise<'ModalDialog' | 'raw-DOM'> {
    const driver = VSBrowser.instance.driver;

    try {
        const dialog = new ModalDialog();
        await driver.wait(
            async () => (await dialog.getMessage().catch(() => '')).includes(DELETE_ENV_NAME),
            MODAL_ATTEMPT_TIMEOUT
        );
        await dialog.pushButton('Delete');

        return 'ModalDialog';
    } catch (error) {
        console.warn('[G2] ModalDialog delete confirmation failed; falling back to raw DOM:', error);
    }

    // Wait for the confirmation dialog (identified by its message naming the env) to be present.
    await driver.wait(
        async () => {
            const box = await driver.findElements(By.css('.monaco-dialog-box')).catch(() => []);
            for (const element of box) {
                if ((await element.getText().catch(() => '')).includes(DELETE_ENV_NAME)) {
                    return true;
                }
            }

            return false;
        },
        WORKBENCH_TIMEOUT,
        `delete-confirmation modal for "${DELETE_ENV_NAME}" did not appear`
    );

    const button = await driver.wait(
        async () => {
            const selector = '.monaco-dialog-box .dialog-buttons .monaco-button, .monaco-dialog-box .monaco-button';
            for (const element of await driver.findElements(By.css(selector)).catch(() => [])) {
                if ((await element.getText().catch(() => '')).trim() === 'Delete') {
                    return element;
                }
            }

            return undefined;
        },
        WORKBENCH_TIMEOUT,
        'custom delete-confirmation modal button "Delete" did not appear'
    );
    if (!button) {
        throw new Error('custom delete-confirmation modal button "Delete" not found');
    }
    await button.click();

    return 'raw-DOM';
}

describe('Deepnote — deleting an environment stops even a closed-but-running notebook’s server', function () {
    this.timeout(SUITE_TIMEOUT);
    this.retries(0); // destructive (deletes the venv); not idempotent

    let cleanupTempDir: (() => void) | undefined;
    let serverPid: number | undefined;
    let modalDrivenVia: 'ModalDialog' | 'raw-DOM' | undefined;
    let aliveWhileClosed = false;
    let aliveAfterDelete = true;
    let lockFileGoneAfterDelete = false;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);
        const copy = copyFixtureToTempDir(G2_FIXTURE);
        cleanupTempDir = copy.cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Servers already running from earlier suites/tests — exclude these when isolating THIS PID.
        const pidsBefore = serverPids();

        await createEnvironment(DELETE_ENV_NAME);

        await openWorkspaceFile(G2_FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(G2_FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${G2_FIXTURE} did not open`
        );

        // Bind the kernel to the dedicated env, then run the single cell — this starts the server and
        // writes its PID lock file.
        await selectEnvironmentForNotebook(DELETE_ENV_NAME, G2_FIXTURE);
        await runOnceAndAwaitOutput(G2_FIXTURE, 'overview', FIRST_RUN_OUTPUT_TIMEOUT);

        // Isolate this run's server PID (the lock file that appeared since we started).
        const pidDeadline = Date.now() + PID_APPEAR_TIMEOUT;
        while (Date.now() < pidDeadline) {
            const fresh = serverPids().filter((pid) => !pidsBefore.includes(pid));
            if (fresh.length > 0) {
                serverPid = fresh[0];
                break;
            }
            await driver.sleep(1000);
        }
        console.log(
            '[G2] serverPid=',
            serverPid,
            'lockDir=',
            LOCK_DIR,
            'lockDirExists=',
            fs.existsSync(LOCK_DIR),
            'pids=',
            JSON.stringify(serverPids())
        );
        if (serverPid === undefined) {
            const tmpEntries = fs.readdirSync(os.tmpdir()).filter((f) => f.includes('deepnote'));
            console.log('[G2] no fresh PID; os.tmpdir() deepnote entries=', JSON.stringify(tmpEntries));
        }
        await screenshot('server-running');

        // Close the notebook tab. Closing a tab does NOT stop the server (no onDidClose->stopServer),
        // so it must still be alive here — that is the state the env-delete has to clean up.
        await new EditorView().closeAllEditors().catch(() => undefined);
        await driver.sleep(CLOSE_SETTLE);
        aliveWhileClosed = serverPid !== undefined && isAlive(serverPid);
        console.log('[G2] aliveWhileClosed=', aliveWhileClosed);

        // Delete the dedicated environment via the Environments tree context menu + confirmation modal.
        const section = await getDeepnoteEnvironmentsSection();
        const envItem = await driver.wait(
            async () => findEnvironmentItem(section, DELETE_ENV_NAME),
            WORKBENCH_TIMEOUT,
            `environment row "${DELETE_ENV_NAME}" did not appear in the Environments view`
        );
        await screenshot('env-row');

        // The context-menu label is the command title "Delete Environment" (not a bare "Delete").
        await selectDeepnoteContextMenu(envItem as ViewItem, 'Delete Environment');
        await screenshot('delete-menu');
        modalDrivenVia = await confirmDeleteModal();
        console.log('[G2] modalDrivenVia=', modalDrivenVia);

        await waitForNotification(/Environment .*deleted/i, WORKBENCH_TIMEOUT, true);
        await screenshot('env-deleted');

        // The closed notebook's server must now be stopped and its lock file removed.
        const stopDeadline = Date.now() + STOP_AFTER_DELETE_TIMEOUT;
        while (Date.now() < stopDeadline) {
            if (serverPid !== undefined && !isAlive(serverPid)) {
                aliveAfterDelete = false;
                break;
            }
            await driver.sleep(1000);
        }
        lockFileGoneAfterDelete =
            serverPid !== undefined && !fs.existsSync(path.join(LOCK_DIR, `server-${serverPid}.json`));
        console.log(
            '[G2] aliveAfterDelete=',
            aliveAfterDelete,
            'lockFileGone=',
            lockFileGoneAfterDelete,
            'pids=',
            JSON.stringify(serverPids())
        );
        await screenshot('after-stop-check');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[env-g2] cleanup:', error);
        }
    });

    it('starts a server whose PID is tracked and survives closing the notebook tab', function () {
        expect(serverPid, 'server PID from lock file').to.be.a('number');
        expect(aliveWhileClosed, 'server still running after the tab was closed').to.equal(true);
    });

    it('stops that closed notebook’s server when the environment is deleted', function () {
        expect(aliveAfterDelete, 'closed notebook server should be stopped after env delete').to.equal(false);
        expect(lockFileGoneAfterDelete, 'server lock file removed after env delete').to.equal(true);
    });
});
