/**
 * End-to-end UI test for "Restart Kernel" on a Deepnote notebook (#471).
 *
 * Restart used to be unreachable on `.deepnote` files: every contribution was scoped to
 * `notebookType == 'jupyter-notebook'` and `deepnote.notebookeditor.canrestartNotebookkernel` was hardwired
 * false for Deepnote notebooks. This drives the *real* toolbar button and asserts the kernel actually
 * restarted — not merely that the command resolved.
 *
 * The probe cell increments a module-level counter, so consecutive runs print 1, 2, 3, … and a real restart
 * sends the sequence back to 1.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    KERNEL_CONNECT_TIMEOUT,
    OUTPUT_POLL_INTERVAL,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickRestartKernel,
    clickRunAll,
    copyFixtureToTempDir,
    createEnvironment,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    readRenderedOutput,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook,
    waitForNotification,
    waitForNotificationToClear
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'restart-kernel.deepnote';
const PROBE_PREFIX = 'RESTART_PROBE:';
// The kernel shows a "Restarting Kernel: <name>" progress toast for the whole restart. A quick restart can
// finish before the toast is seen, so waiting for it to appear is best-effort; waiting for it to clear is not.
const RESTART_TOAST_PATTERN = /Restarting Kernel/;
const RESTART_TOAST_APPEAR_TIMEOUT = 15_000;

/** Runs the notebook once and polls until the probe prints any of `candidates`, returning the rendered text. */
async function runAndAwaitProbe(candidates: number[], timeout: number): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const needles = candidates.map((value) => `${PROBE_PREFIX}${value}`);

    await dismissAllNotifications().catch((error) => {
        console.warn('[deepnote-e2e] dismiss notifications before Run All:', error);
    });
    await clickRunAll(NOTEBOOK_FILE_NAME);

    const deadline = Date.now() + timeout;
    let lastText = '';
    while (Date.now() < deadline) {
        lastText = await readRenderedOutput();
        if (needles.some((needle) => lastText.includes(needle))) {
            return lastText;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    throw new Error(
        `Timed out after ${timeout}ms waiting for the probe to print one of ${JSON.stringify(needles)}. ` +
            `Last observed output: ${JSON.stringify(lastText)}`
    );
}

describe('Deepnote E2E — Restart Kernel from the notebook toolbar', function () {
    this.timeout(SUITE_TIMEOUT);

    const environmentName = 'E2E Restart Env';

    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // A workspace folder is required: the serializer's snapshot read blocks headlessly without one, and
        // the kernel auto-selector needs its requirements.txt path (see helloWorld.e2e.test.ts).
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(NOTEBOOK_FILE_NAME);
        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[deepnote-e2e] close all editors during cleanup:', error);
        });

        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[deepnote-e2e] remove temp workspace dir during cleanup:', error);
        }
    });

    it('restarts the kernel from the toolbar button and drops the kernel state', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        // First run starts the kernel; the second proves the probe really reads state left in the kernel,
        // otherwise a "1" after the restart would prove nothing.
        await runOnceAndAwaitOutput(NOTEBOOK_FILE_NAME, `${PROBE_PREFIX}1`, FIRST_RUN_OUTPUT_TIMEOUT);
        await runAndAwaitProbe([2], FIRST_RUN_OUTPUT_TIMEOUT);

        // The button is greyed out until `canrestartNotebookkernel` flips for the Deepnote notebook, so this
        // click also asserts the context key is maintained for Deepnote notebooks.
        await dismissAllNotifications().catch((error) => {
            console.warn('[deepnote-e2e] dismiss notifications before Restart Kernel:', error);
        });
        await clickRestartKernel(NOTEBOOK_FILE_NAME);

        // Let the restart land before running again, so the run cannot race the dying kernel.
        await waitForNotification(RESTART_TOAST_PATTERN, RESTART_TOAST_APPEAR_TIMEOUT, false);
        await waitForNotificationToClear(RESTART_TOAST_PATTERN, KERNEL_CONNECT_TIMEOUT);

        // A restarted kernel has forgotten `counter`, so the probe starts over at 1; a kernel that merely kept
        // running would print 3.
        const output = await runAndAwaitProbe([1, 3], FIRST_RUN_OUTPUT_TIMEOUT);
        expect(output, 'the probe kept counting, so the kernel was not restarted').to.not.contain(`${PROBE_PREFIX}3`);
        expect(output).to.contain(`${PROBE_PREFIX}1`);
    });
});
