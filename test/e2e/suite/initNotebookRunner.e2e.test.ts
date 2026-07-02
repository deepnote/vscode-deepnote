/**
 * End-to-end UI test (ExTester / vscode-extension-tester) for the Deepnote init-notebook runner.
 * When a main notebook's kernel starts, the extension runs the sibling INIT notebook's code blocks
 * (hidden) so their definitions land in the main kernel. Fixtures:
 *   - `etl-pipeline-extract.deepnote` — the main ("Extract", cell `print(INIT_MARKER)`), references
 *     the init notebook via `initNotebookId`.
 *   - `etl-pipeline-init.deepnote` — the init sibling ("Init"), defines `INIT_MARKER = "init-ran"`.
 * Both live in the same workspace folder so the runner can discover the init sibling.
 *
 * Requires a discoverable Python interpreter: creating the environment provisions a venv + the
 * Deepnote toolkit (network access), and the first kernel start can take a few minutes.
 * Screenshots are captured into `test/e2e/screenshots/initNotebookRunner/`.
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
// Restart AND re-run in one command so no separate toolbar "Run All" click is needed — that click
// is intermittently intercepted by the transient kernel picker VS Code shows right after a restart.
const RESTART_AND_RUN_COMMAND = 'Deepnote: Restart Kernel and Run All Cells';
// Built-in VS Code command (`notebook.clearAllCellsOutputs`) that empties every cell's rendered
// output for the active notebook. Its command-palette label is exactly "Notebook: Clear All
// Outputs" (category "Notebook" + title "Clear All Outputs"); the string must match or
// `Workbench.executeCommand` silently runs whatever entry is first in the palette instead. The
// notebook is a `jupyter-notebook`-typed editor, so this applies — there is no Deepnote-specific
// clear-outputs command. Driven via the palette (keyboard-focused) rather than the toolbar "Clear
// All Outputs" button, whose positional click is intermittently intercepted by the transient kernel
// quick pick that overlays the notebook toolbar.
const CLEAR_ALL_OUTPUTS_COMMAND = 'Notebook: Clear All Outputs';
// Short window to confirm the stale marker actually disappeared after clearing outputs. If it never
// clears, the restart test must fail rather than accept a stale `init-ran` — so this stays tight.
const CLEAR_OUTPUT_TIMEOUT = 15_000;
// How long to wait for the "Change kernel for …" quick pick that VS Code opens right after
// `RESTART_AND_RUN_COMMAND`. When it appears it blocks the re-run until a kernel is chosen; when the
// kernel is already bound it may not appear at all, so a miss is not fatal.
const KERNEL_PICKER_TIMEOUT = 8_000;
// Let the clear command's palette fully close before the restart command opens a new palette;
// otherwise the back-to-back palette cycles can race and the restart command misses.
const PALETTE_SETTLE_DELAY = 1_000;
// After the restart, give the combined restart+run a chance to start executing. If no output has
// appeared within this window, the auto-run portion of the combined command was dropped, so nudge it
// with a single toolbar "Run All" on the (now restarted, picker-free) kernel. This still proves a
// fresh execution: the output was cleared and confirmed gone before the restart, so any marker seen
// afterwards is newly produced — never the stale one from the first test.
const RESTART_RUN_START_TIMEOUT = 30_000;

/**
 * Empties the active notebook's rendered output so a later marker is provably fresh, then polls the
 * output webview until `INIT_MARKER` is gone. A broken clear surfaces as a test failure instead of
 * leaving a stale marker that could mask a broken restart/init-rerun.
 */
async function clearOutputsAndConfirmMarkerGone(): Promise<void> {
    const driver = VSBrowser.instance.driver;

    // Clear any toasts first — they can steal focus from the command palette input. Focus the
    // notebook editor AFTER, so the clear command's "active notebook editor" precondition holds.
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
 * After a restart, VS Code can open a "Change kernel for …" quick pick with the notebook's current
 * kernel pre-selected; until it is confirmed the re-run does not proceed (the cell stays unexecuted).
 * Confirm it with Enter to accept the highlighted kernel. When no such picker is open (kernel already
 * bound), this is a no-op.
 */
async function confirmKernelPickerIfPresent(): Promise<void> {
    let picker: InputBox;
    try {
        picker = await InputBox.create(KERNEL_PICKER_TIMEOUT);
    } catch {
        // No quick pick opened — the re-run proceeded without asking for a kernel.
        return;
    }

    const placeholder = await picker.getPlaceHolder().catch(() => '');
    if (!/change kernel|select.*kernel/i.test(placeholder)) {
        // Some other input box (unexpected) — leave it for the caller's own handling.
        return;
    }

    // Accept the pre-selected (current) kernel so the restart's queued re-run executes.
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

        // Place the main notebook AND its sibling init notebook in the same workspace folder — the
        // init runner discovers the init sibling by scanning the notebook's directory.
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

        // Create + select the environment; selecting connects the kernel, which triggers the init run.
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
        // The Extract cell prints INIT_MARKER, which only exists if the sibling init notebook ran
        // (hidden) when the kernel started.
        const output = await runOnceAndAwaitOutput(MAIN_FILE, INIT_MARKER, FIRST_RUN_OUTPUT_TIMEOUT);
        await screenshot('init-ran-output');
        expect(output).to.contain(INIT_MARKER);
    });

    it('re-runs the init notebook after a kernel restart', async function () {
        const driver = VSBrowser.instance.driver;

        await new EditorView().openEditor(MAIN_FILE);
        await dismissAllNotifications();

        // The first test already left INIT_MARKER rendered, and a restart does NOT clear cell output
        // (it clears only once the re-run emits its first output). So clear the output up front and
        // confirm the marker is gone — otherwise the poll below could break on the STALE marker and
        // pass without ever proving a fresh post-restart execution.
        await clearOutputsAndConfirmMarkerGone();
        await screenshot('outputs-cleared');

        // Let the clear palette fully close and re-focus the notebook so the restart command targets
        // the right editor and does not race a still-closing palette.
        await driver.sleep(PALETTE_SETTLE_DELAY);
        await new EditorView().openEditor(MAIN_FILE);

        // Restart the kernel AND re-run all cells in one action. A restart clears in-kernel state, so
        // the cell prints INIT_MARKER again only if the init notebook re-ran on the fresh kernel to
        // redefine it. Since the output was just cleared, an INIT_MARKER observed below is provably
        // newly produced by this restart+run, not the stale one from the first test.
        await new Workbench().executeCommand(RESTART_AND_RUN_COMMAND);

        // The restart can raise a "Change kernel for …" quick pick that blocks the queued re-run
        // until dismissed; accept the pre-selected current kernel so the cells actually execute.
        await confirmKernelPickerIfPresent();
        await driver.sleep(3000);

        // If the combined command's auto-run was dropped (no output has started), nudge it with a
        // single toolbar "Run All" on the now-restarted, picker-free kernel. Output was cleared and
        // confirmed gone above, so this still proves a fresh execution rather than accepting a stale
        // marker.
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
