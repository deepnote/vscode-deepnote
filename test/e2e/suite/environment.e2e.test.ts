/**
 * E2E (ExTester): splitting a multi-notebook file that had a selected environment migrates that
 * environment onto every split child. Signal: the `.vscode/deepnote.json` sidecar (projectId ->
 * environmentId). We select an env for the original, accept the split, DELETE the sidecar, then open
 * a split child — the sidecar is regenerated solely from the child's migrated mapping. Requires a
 * Python kernel.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { By, EditorView, InputBox, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    KERNEL_CONNECT_TIMEOUT,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
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

describe('Deepnote — deleting an environment stops even a closed-but-running notebook’s server', function () {
    this.timeout(SUITE_TIMEOUT);

    // Skipped: this check needs to observe an OUT-OF-PROCESS kernel/server's lifecycle, and ExTester
    // has no deterministic UI- or disk-observable signal that a CLOSED notebook's server has stopped.
    // The delete-environment command only surfaces an "Environment … deleted" toast (which proves the
    // command ran, not that a closed notebook's server stopped); the server itself is managed by
    // @deepnote/runtime-core with no tree/status-bar/notification/file trace, and the env-view tree
    // lists environments, not running servers. The guarantee — delete resolves ALL notebooks using the
    // env from the persisted per-notebook mapping (INCLUDING closed ones) and calls stopServer for each
    // — is covered directly by the unit test "one notebook is OPEN; the other is CLOSED but its server
    // is still running" in deepnoteEnvironmentsView.unit.test.ts.
    it.skip('stops the server of a closed notebook that used the deleted environment', function () {
        // Intended flow: map one environment to two sibling notebooks, run a cell in each so both have
        // running servers, close one tab, delete the environment (accept the modal), and assert BOTH
        // servers stop — including the closed notebook's. Not drivable via ExTester: a stopped
        // out-of-process server has no observable UI or on-disk signal (see the skip rationale above).
    });
});
