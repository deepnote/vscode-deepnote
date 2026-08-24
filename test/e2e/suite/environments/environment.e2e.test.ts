/**
 * E2E (ExTester): splitting a multi-notebook file migrates its selected environment onto every child.
 * Signal: the `.vscode/deepnote.json` sidecar, deleted post-split so a child regenerates it from the migration.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    By,
    EditorView,
    InputBox,
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
    assertNotNull,
    confirmModalDialog,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    openActivityBarView,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectDeepnoteContextMenu,
    selectEnvironmentForNotebook,
    waitForNotification
} from '../../helpers';

const FIXTURE = 'sales-analytics.deepnote';
const CHILD = 'sales-analytics-overview.deepnote';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENV_NAME = 'E2E Split Migration Env';
const SPLIT_PROMPT = /multiple notebooks/i;
const SPLIT_ACTION = 'Split into separate files';
const SPLIT_DONE = /Split into \d+ files\./i;

const SIDECAR_REGEN_TIMEOUT = 30_000;
const SIDECAR_POLL_INTERVAL = 1_000;

const INLINE_PROMPT_TIMEOUT = 15_000;
const RELOAD_SETTLE = 3_000;

/**
 * Reloads the VS Code window and waits until it is interactive again. Waiting for the pre-reload
 * `.monaco-workbench` to go stale avoids racing the UI against a window still tearing down.
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

        // Select env WITHOUT dismissing the split prompt: replicate selectEnvironmentForNotebook minus
        // its dismissAllNotifications() call, which would kill the still-open split toast.
        await new EditorView().openEditor(FIXTURE);
        await new Workbench().executeCommand('Deepnote: Select Environment for Notebook');
        const pick = await InputBox.create(QUICK_PICK_TIMEOUT);
        await pick.setText(ENV_NAME);
        await driver.wait(async () => (await pick.getQuickPicks()).length > 0, QUICK_PICK_TIMEOUT, 'env pick empty');
        await pick.confirm();
        await waitForNotification(/switched successfully/i, KERNEL_CONNECT_TIMEOUT, false);
        await screenshot('env-selected');

        // The kernel rebuild can let the toast collapse out of `getNotifications()` view; if gone,
        // reload to clear the prompted-once guard so reopening re-raises the split prompt.
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

        // Re-find the toast on each attempt instead of reusing the reference captured before the
        // screenshot above: the notification re-renders while it sits there, which stales it. Same
        // locate-and-act-in-one-loop shape as clickRunAll.
        assertNotNull(prompt, 'split prompt notification');
        await driver.wait(
            async () => {
                const current = await waitForNotification(SPLIT_PROMPT, INLINE_PROMPT_TIMEOUT, false);
                if (!current) {
                    return false;
                }

                try {
                    await current.takeAction(SPLIT_ACTION);

                    return true;
                } catch (error) {
                    console.warn('[deepnote-e2e] take split action (retrying):', error);

                    return false;
                }
            },
            WORKBENCH_TIMEOUT,
            `could not take the "${SPLIT_ACTION}" action on the split prompt`
        );
        await waitForNotification(SPLIT_DONE, WORKBENCH_TIMEOUT, true);
        await driver.sleep(2500);
        await screenshot('split-done');

        // Delete the sidecar so only a child's migrated mapping can rewrite it (proves migration, not
        // a stale pre-split entry).
        const sidecarPath = path.join(tempDir, '.vscode', 'deepnote.json');
        fs.rmSync(sidecarPath, { force: true });

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

// The server starter writes/deletes one PID lock file per running server under this dir. The test
// shares os.tmpdir() with the extension host, so reading the dir is the only cross-process stop signal.
const LOCK_DIR = path.join(os.tmpdir(), 'vscode-deepnote-locks');

const DELETE_ENV_NAME = 'E2E Delete Env';
const G2_FIXTURE = 'marketing-overview.deepnote';

const PID_APPEAR_TIMEOUT = 15_000;
const CLOSE_SETTLE = 2_500;
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
 * Cross-platform liveness check via `process.kill(pid, 0)` (sends no signal): throws `ESRCH` when the
 * process is gone, `EPERM` when it exists but is owned by another user — so `EPERM` counts as alive.
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
    await openActivityBarView('Deepnote');
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

describe('Deepnote — deleting an environment stops even a closed-but-running notebook’s server', function () {
    this.timeout(SUITE_TIMEOUT);
    this.retries(0); // destructive (deletes the venv); not idempotent

    let cleanupTempDir: (() => void) | undefined;
    let serverPid: number | undefined;
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

        // Servers already running from earlier suites — exclude these when isolating THIS PID.
        const pidsBefore = serverPids();

        await createEnvironment(DELETE_ENV_NAME, { useManagedVenv: true });

        await openWorkspaceFile(G2_FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(G2_FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${G2_FIXTURE} did not open`
        );

        // Running the cell starts the server and writes its PID lock file.
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

        // Closing a tab does NOT stop the server, so it stays alive here — the state env-delete must clean up.
        await new EditorView().closeAllEditors().catch(() => undefined);
        await driver.sleep(CLOSE_SETTLE);
        aliveWhileClosed = serverPid !== undefined && isAlive(serverPid);
        console.log('[G2] aliveWhileClosed=', aliveWhileClosed);

        const section = await getDeepnoteEnvironmentsSection();
        const envItem = await driver.wait(
            async () => findEnvironmentItem(section, DELETE_ENV_NAME),
            WORKBENCH_TIMEOUT,
            `environment row "${DELETE_ENV_NAME}" did not appear in the Environments view`
        );
        await screenshot('env-row');

        await selectDeepnoteContextMenu(envItem as ViewItem, 'Delete Environment');
        await screenshot('delete-menu');
        await confirmModalDialog('Delete', { messageIncludes: DELETE_ENV_NAME });

        await waitForNotification(/Environment .*deleted/i, WORKBENCH_TIMEOUT, true);
        await screenshot('env-deleted');

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
