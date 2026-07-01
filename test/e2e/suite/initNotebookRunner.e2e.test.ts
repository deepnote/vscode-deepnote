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
import { EditorView, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    OUTPUT_POLL_INTERVAL,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
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

        // Restart the kernel AND re-run all cells in one action. A restart clears in-kernel state, so
        // the cell prints INIT_MARKER again only if the init notebook re-ran on the fresh kernel to
        // redefine it. Let the restart clear the previous output before polling for the new one.
        await new Workbench().executeCommand(RESTART_AND_RUN_COMMAND);
        await driver.sleep(3000);

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
