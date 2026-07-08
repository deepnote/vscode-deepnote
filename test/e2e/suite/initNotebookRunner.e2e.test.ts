/**
 * E2E (ExTester): when a main notebook's kernel starts, the extension runs the sibling init notebook's
 * code blocks (hidden) so their definitions land in the main kernel. Needs a discoverable interpreter.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, InputBox, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    OUTPUT_POLL_INTERVAL,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickRunAll,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    readRenderedOutput,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../helpers';

const MAIN_FILE = 'etl-pipeline-extract.deepnote';
const INIT_SIBLING_FILE = 'etl-pipeline-init.deepnote';
const INIT_MARKER = 'init-ran';
// Restart AND re-run in one command so no separate "Run All" click is needed — that click is
// intermittently intercepted by the transient kernel picker VS Code shows right after a restart.
const RESTART_AND_RUN_COMMAND = 'Deepnote: Restart Kernel and Run All Cells';
// Exact palette label matters: `Workbench.executeCommand` silently runs the first palette entry on a
// mismatch. Driven via the palette because the toolbar button's click is intercepted by the kernel picker.
const CLEAR_ALL_OUTPUTS_COMMAND = 'Notebook: Clear All Outputs';
const CLEAR_OUTPUT_TIMEOUT = 15_000;
// The "Change kernel for …" quick pick that may open after a restart blocks the re-run; a miss is not
// fatal since it may not appear when the kernel is already bound.
const KERNEL_PICKER_TIMEOUT = 8_000;
// Let the clear command's palette fully close before the restart command opens a new one, else the
// back-to-back palette cycles race and the restart command misses.
const PALETTE_SETTLE_DELAY = 1_000;
// If no output appears within this window the combined command's auto-run was dropped, so nudge it
// with a single "Run All". Output was cleared before the restart, so any marker seen after is fresh.
const RESTART_RUN_START_TIMEOUT = 30_000;
// Give the restart-and-run command's palette time to dismiss and the restart to begin before polling.
const RESTART_COMMAND_SETTLE_DELAY = 3_000;

/** Empties the active notebook's output so a later marker is provably fresh, polling until `INIT_MARKER` is gone. */
async function clearOutputsAndConfirmMarkerGone(): Promise<void> {
    const driver = VSBrowser.instance.driver;

    // Clear toasts first (they steal focus from the palette input), then focus the notebook so the
    // clear command's "active notebook editor" precondition holds.
    await dismissAllNotifications();
    await new EditorView().openEditor(MAIN_FILE);

    await new Workbench().executeCommand(CLEAR_ALL_OUTPUTS_COMMAND);

    const deadline = Date.now() + CLEAR_OUTPUT_TIMEOUT;
    let output = await readRenderedOutput();

    while (output.includes(INIT_MARKER) && Date.now() < deadline) {
        await driver.sleep(OUTPUT_POLL_INTERVAL);
        output = await readRenderedOutput();
    }

    expect(output, 'clearing outputs did not remove the stale init marker').to.not.contain(INIT_MARKER);
}

/**
 * Confirms the "Change kernel for …" quick pick VS Code may open after a restart (which blocks the
 * re-run until dismissed). No-op when no such picker is open.
 */
async function confirmKernelPickerIfPresent(): Promise<void> {
    let picker: InputBox;
    try {
        picker = await InputBox.create(KERNEL_PICKER_TIMEOUT);
    } catch {
        return;
    }

    const placeholder = await picker.getPlaceHolder().catch(() => '');
    if (!/change kernel|select.*kernel/i.test(placeholder)) {
        return;
    }

    await picker.confirm().catch((error) => {
        console.warn('[init-runner] confirm kernel picker after restart:', error);
    });
}

describe('Deepnote — running the sibling init notebook in a main notebook kernel', function () {
    this.timeout(SUITE_TIMEOUT);

    const environmentName = 'E2E Init Env';
    let cleanupTempDir: (() => void) | undefined;
    let screenshot: (label: string) => Promise<string>;

    before(async function () {
        screenshot = createScreenshotter(this);

        // Both notebooks must share a workspace folder: the init runner discovers the sibling by
        // scanning the notebook's directory.
        const copy = copyFixtureToTempDir(MAIN_FILE);
        cleanupTempDir = copy.cleanup;
        const initSrc = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', INIT_SIBLING_FILE);
        fs.copyFileSync(initSrc, path.join(copy.tempDir, INIT_SIBLING_FILE));

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(MAIN_FILE);
        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(MAIN_FILE)),
            WORKBENCH_TIMEOUT,
            `${MAIN_FILE} did not open`
        );

        // Selecting the environment connects the kernel, which triggers the init run.
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, MAIN_FILE);
        await screenshot('kernel-connected');
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[init-runner] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[init-runner] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[init-runner] remove temp workspace dir during cleanup:', error);
        }
    });

    it('runs the init notebook on kernel start so its variable is defined in the main kernel', async function () {
        // The Extract cell prints INIT_MARKER, which only exists if the sibling init notebook ran.
        const output = await runOnceAndAwaitOutput(MAIN_FILE, INIT_MARKER, FIRST_RUN_OUTPUT_TIMEOUT);
        await screenshot('init-ran-output');
        expect(output).to.contain(INIT_MARKER);
    });

    it('re-runs the init notebook after a kernel restart', async function () {
        const driver = VSBrowser.instance.driver;

        await new EditorView().openEditor(MAIN_FILE);
        await dismissAllNotifications();

        // A restart does NOT clear cell output (only the re-run's first output does), so clear the
        // stale INIT_MARKER up front — else the poll below could pass on it without proving a fresh run.
        await clearOutputsAndConfirmMarkerGone();
        await screenshot('outputs-cleared');

        // Let the clear palette fully close and re-focus so the restart command targets the right editor.
        await driver.sleep(PALETTE_SETTLE_DELAY);
        await new EditorView().openEditor(MAIN_FILE);

        // Restart clears in-kernel state, so the cell reprints INIT_MARKER only if the init notebook
        // re-ran on the fresh kernel; since output was just cleared, any marker below is provably fresh.
        await new Workbench().executeCommand(RESTART_AND_RUN_COMMAND);

        await confirmKernelPickerIfPresent();
        await driver.sleep(RESTART_COMMAND_SETTLE_DELAY);

        // Nudge a single "Run All" if the combined command's auto-run was dropped; output was cleared
        // above so this still proves a fresh execution.
        const runStartDeadline = Date.now() + RESTART_RUN_START_TIMEOUT;
        let nudged = false;
        while (Date.now() < runStartDeadline) {
            if ((await readRenderedOutput()) !== '') {
                break;
            }

            if (!nudged) {
                nudged = true;
                await clickRunAll(MAIN_FILE).catch((error) => {
                    console.warn('[init-runner] nudge Run All after restart:', error);
                });
            }

            await driver.sleep(OUTPUT_POLL_INTERVAL);
        }

        const deadline = Date.now() + FIRST_RUN_OUTPUT_TIMEOUT;
        let output = '';

        while (Date.now() < deadline) {
            output = await readRenderedOutput();
            if (output.includes(INIT_MARKER)) {
                break;
            }

            await driver.sleep(OUTPUT_POLL_INTERVAL);
        }

        await screenshot('init-reran-output');
        expect(output).to.contain(INIT_MARKER);
    });
});
