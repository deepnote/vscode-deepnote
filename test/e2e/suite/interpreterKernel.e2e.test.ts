/**
 * End-to-end UI test for kernel setup WITHOUT Deepnote environments, following the Jupyter
 * extension's mechanism for a missing Python dependency:
 *   1. opening a `.deepnote` file registers a controller named after the interpreter — nothing is
 *      installed and no server starts
 *   2. running a cell detects that deepnote-toolkit is missing and asks for consent (modal prompt)
 *   3. on "Install" the toolkit goes into the workspace's *active interpreter*, not a managed venv
 *   4. the server starts, the connection is updated in place, and that same run executes the cell
 *
 * The workspace's active interpreter is a bare venv this test creates, so the install path runs on
 * every execution rather than only on a machine that happens to be missing the package. The cell
 * prints `sys.prefix`, so the output proves the kernel ran inside that venv.
 *
 * Screenshots are captured at each step into `test/e2e/screenshots/interpreterKernel/` so the flow
 * can be confirmed visually — in particular that the consent prompt is actually shown.
 *
 * Prerequisites:
 *   - The Python extension (`ms-python.python`) must be installed in the test instance.
 *   - `python3` must be on PATH and able to create a venv (CI installs `python3.12-venv`).
 *   - Network access: the toolkit is installed from PyPI, which is slow.
 */

import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    KERNEL_CONNECT_TIMEOUT,
    OUTPUT_POLL_INTERVAL,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickRunAll,
    confirmModalDialog,
    copyFixtureToTempDir,
    createScreenshotter,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    readRenderedOutput,
    tryOpenInputBox,
    waitForNotification
} from '../helpers';

const NOTEBOOK_FILE_NAME = 'interpreter-kernel.deepnote';
const EXPECTED_OUTPUT = 'interpreter-kernel-ok';

/** How long the notebook is watched to prove that merely opening it installs nothing. */
const NO_INSTALL_OBSERVATION_MS = 15_000;

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

describe('Deepnote E2E — consent, then install into the active interpreter', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let venvDir: string;
    let interpreter: string;

    before(async function () {
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        venvDir = path.join(tempDir, '.venv');
        execFileSync('python3', ['-m', 'venv', venvDir], { stdio: 'inherit' });
        interpreter = venvPython(venvDir);

        expect(isToolkitInstalled(interpreter)).to.equal(
            false,
            'precondition: the fresh venv must not already provide deepnote-toolkit'
        );

        // Pin the workspace's interpreter so the kernel resolves this venv and not whatever the
        // Python extension would otherwise discover on the machine.
        const vscodeDir = path.join(tempDir, '.vscode');
        fs.mkdirSync(vscodeDir, { recursive: true });
        fs.writeFileSync(
            path.join(vscodeDir, 'settings.json'),
            JSON.stringify({ 'python.defaultInterpreterPath': interpreter }, undefined, 4)
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
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

    it('installs nothing on open, asks before installing, then runs the cell', async function () {
        const shot = createScreenshotter(this);
        const driver = VSBrowser.instance.driver;

        await openWorkspaceFile(NOTEBOOK_FILE_NAME);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );

        // The load-bearing half of "detect on kernel start, not notebook open". Watching the install
        // toast rather than only the venv is what makes this catch a regression: an open-time install
        // announces itself within seconds, long before the package would actually land on disk.
        const installStartedOnOpen = await waitForNotification(
            /Installing deepnote_toolkit/i,
            NO_INSTALL_OBSERVATION_MS,
            false
        );

        // Taken after that window so the notebook has rendered: it shows the kernel already named
        // after the interpreter while nothing has been installed and no server is running.
        await shot('notebook-open');

        expect(installStartedOnOpen, 'opening the notebook must not start an install').to.equal(undefined);
        expect(isToolkitInstalled(interpreter)).to.equal(
            false,
            'opening the notebook must not install anything into the interpreter'
        );

        // Running a cell is the user gesture that triggers detection, and the consent prompt.
        await dismissAllNotifications().catch(() => undefined);
        await clickRunAll(NOTEBOOK_FILE_NAME);

        await confirmModalDialog('Install', {
            messageIncludes: 'deepnote-toolkit',
            onVisible: async () => {
                await shot('consent-prompt');
            }
        });

        await driver.wait(
            () => isToolkitInstalled(interpreter),
            KERNEL_CONNECT_TIMEOUT,
            'deepnote-toolkit was never installed into the active interpreter'
        );

        // No second click: consent updates the existing controller's connection in place, so the run
        // that triggered the prompt is the run that executes.
        let renderedOutput = '';

        await driver.wait(
            async () => {
                renderedOutput = await readRenderedOutput();

                return renderedOutput.includes(EXPECTED_OUTPUT);
            },
            KERNEL_CONNECT_TIMEOUT,
            `the run that triggered the prompt never rendered "${EXPECTED_OUTPUT}"`,
            OUTPUT_POLL_INTERVAL
        );

        await shot('cell-output');

        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);

        // The cell printed sys.prefix: the kernel must be the venv this test created, which is what
        // separates "active interpreter" from the old Deepnote-managed environment.
        expect(renderedOutput).to.contain(venvDir);

        // The kernel picker is the only place the description is rendered, so open it to capture
        // both halves of the entry: the environment name as the label, its path as the description.
        await new Workbench().executeCommand('notebook.selectKernel');

        const picker = await tryOpenInputBox(QUICK_PICK_TIMEOUT);

        expect(picker, 'the kernel picker should open').to.not.equal(undefined);

        await shot('kernel-picker');
        await picker?.cancel();
    });
});
