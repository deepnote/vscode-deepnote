/**
 * End-to-end UI test for kernel setup WITHOUT Deepnote environments.
 *
 * This is the flow the extension uses now that environments are gone: the kernel is built from the
 * workspace's *active Python interpreter*, and deepnote-toolkit is installed into that interpreter
 * through the Python extension's installer infrastructure (`IInstaller`) — the same mechanism the
 * Jupyter extension uses for its own missing dependencies:
 *   1. open a one-notebook `.deepnote` file against a workspace whose active interpreter is a bare venv
 *   2. the auto-selector picks that interpreter — no environment is created and no picker appears
 *   3. deepnote-toolkit is missing, so an "Installing deepnote-toolkit" progress notification shows
 *   4. once it installs, the server starts and the kernel controller is bound
 *   5. run the cell and assert the rendered stdout
 *
 * The cell prints `sys.prefix`, so the output proves the kernel really ran inside the venv this test
 * created rather than in a Deepnote-managed environment. The suite also asserts the toolkit landed in
 * that same venv, which is the load-bearing difference from the environment-based flow.
 *
 * Prerequisites:
 *   - The Python extension (`ms-python.python`) must be installed in the test instance
 *     (`npm run setup:e2e:deps`).
 *   - `python3` must be on PATH and able to create a venv (CI installs `python3.12-venv`).
 *   - Network access: the toolkit is installed from PyPI on first kernel start, which is slow.
 */

import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    KERNEL_CONNECT_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    waitForNotification,
    waitForNotificationToClear
} from '../helpers';

const NOTEBOOK_FILE_NAME = 'interpreter-kernel.deepnote';
const EXPECTED_OUTPUT = 'interpreter-kernel-ok';

// The install toast is observed opportunistically; the venv check below is the real gate, so a
// missed toast must not cost the suite a full kernel-connect timeout.
const TOOLKIT_NOTIFICATION_TIMEOUT = 90_000;

/** Path to the interpreter inside a venv, for the platform the test is running on. */
function venvPython(venvDir: string): string {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

/** True when `deepnote_toolkit` imports in the given interpreter. */
function isToolkitInstalled(python: string): boolean {
    try {
        execFileSync(python, ['-c', 'import deepnote_toolkit'], { stdio: 'ignore' });

        return true;
    } catch {
        return false;
    }
}

describe('Deepnote E2E — run on the active interpreter (no Deepnote environment)', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let venvDir: string;
    let interpreter: string;

    before(async function () {
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        // A throwaway venv is what makes this test deterministic: it is guaranteed not to have
        // deepnote-toolkit, so the install path runs on every execution rather than only on a
        // machine that happens to be missing the package.
        venvDir = path.join(tempDir, '.venv');
        execFileSync('python3', ['-m', 'venv', venvDir], { stdio: 'inherit' });
        interpreter = venvPython(venvDir);

        expect(isToolkitInstalled(interpreter)).to.equal(
            false,
            'precondition: the fresh venv must not already provide deepnote-toolkit'
        );

        // Pin the workspace's interpreter so the auto-selector resolves this venv and not whatever
        // the Python extension would otherwise discover on the machine.
        const vscodeDir = path.join(tempDir, '.vscode');
        fs.mkdirSync(vscodeDir, { recursive: true });
        fs.writeFileSync(
            path.join(vscodeDir, 'settings.json'),
            JSON.stringify({ 'python.defaultInterpreterPath': interpreter }, undefined, 4)
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Opening the folder reloads the window, so the notebook is opened in the test body — that
        // keeps the install notification, which fires during the open, inside the assertions.
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
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

    it('installs deepnote-toolkit into the active interpreter, then runs the cell', async function () {
        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );

        // Opening the notebook auto-selects the kernel, which finds the toolkit missing and installs
        // it — no environment is created and the user is never asked to pick one. The progress toast
        // is the visible half of that, but it is transient (and absent on a retry, where the toolkit
        // is already installed), so it is observed best-effort; the durable assertions are below.
        await waitForNotification(/Installing deepnote-toolkit/i, TOOLKIT_NOTIFICATION_TIMEOUT, false);

        // The load-bearing gate: the install landed in the active interpreter. Polling the venv is
        // race-free, unlike matching a toast that may already have gone.
        await VSBrowser.instance.driver.wait(
            () => isToolkitInstalled(interpreter),
            KERNEL_CONNECT_TIMEOUT,
            'deepnote-toolkit was never installed into the active interpreter'
        );

        // Waiting for the auto-select toast to be *gone* gates "Run All" on a bound kernel without
        // depending on catching it while it is shown.
        await waitForNotificationToClear(/Auto-selecting Deepnote kernel/i, KERNEL_CONNECT_TIMEOUT);

        const renderedOutput = await runOnceAndAwaitOutput(
            NOTEBOOK_FILE_NAME,
            EXPECTED_OUTPUT,
            FIRST_RUN_OUTPUT_TIMEOUT
        );

        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);

        // The cell printed sys.prefix: the kernel must be the venv this test created, which is what
        // separates "active interpreter" from the old Deepnote-managed environment.
        expect(renderedOutput).to.contain(venvDir);
    });
});
