/**
 * End-to-end UI test driven by ExTester (vscode-extension-tester).
 *
 * It exercises the full Deepnote happy path through the *real* VS Code UI:
 *   1. open a one-notebook `.deepnote` file containing `print("hello world")`
 *   2. create a Deepnote environment            (command `deepnote.environments.create`)
 *   3. select that environment for the notebook (command `deepnote.environments.selectForNotebook`)
 *      — this builds and selects the notebook's kernel controller ("kernel connected")
 *   4. run the cell                             (the notebook toolbar's "Run All" button)
 *   5. assert the rendered stdout output contains "hello world"
 *
 * The reusable interaction helpers live in `test/e2e/helpers/`; this file is only the suite wiring.
 *
 * Prerequisites:
 *   - The Python extension (`ms-python.python`) must be installed in the test instance
 *     (`npm run setup:e2e:deps`) and at least one Python interpreter must be discoverable.
 *   - Creating the environment provisions a venv and the Deepnote toolkit, which needs network
 *     access; the first kernel start can take a few minutes.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    SHARED_ENV_NAME,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createEnvironment,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput,
    selectEnvironmentForNotebook
} from '../helpers';

const NOTEBOOK_FILE_NAME = 'hello-world.deepnote';
const EXPECTED_OUTPUT = 'hello world';

describe('Deepnote E2E — run "hello world"', function () {
    // Per-test timeout for the whole suite (overrides the mocharc default for these tests).
    this.timeout(SUITE_TIMEOUT);

    // A stable name: createEnvironment is idempotent (it treats "already exists" as success), so a
    // leftover environment from a previous or retried run is reused rather than colliding — which
    // also lets a persistent test instance reuse the already-provisioned venv.
    const environmentName = SHARED_ENV_NAME;

    // Captured in `before` and invoked in `after` to remove the throwaway temp dir.
    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        // Work on a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp directory as a workspace folder FIRST. The Deepnote serializer reads a
        // "snapshot" during deserialization and, with no workspace folder open, blocks on a
        // `showWarningMessage('Cannot read snapshot: No workspace folders found.')` that never
        // resolves headlessly — leaving the notebook blank. A workspace folder also provides the
        // requirements.txt path the kernel auto-selector needs. (Opening a folder reloads the
        // window, so we re-wait for the workbench afterwards.)
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Now that the containing folder is the workspace, the notebook is reachable by name.
        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        // The native notebook editor opens because the extension registers a serializer for the
        // `deepnote` notebook type; a single-notebook file resolves to its default notebook.
        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        // Defensive cleanup: never leave the driver stuck inside a webview frame, and close tabs.
        await new WebView().switchBack().catch((error) => {
            console.warn('[deepnote-e2e] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[deepnote-e2e] close all editors during cleanup:', error);
        });

        // Remove the throwaway temp dir last so a failure above can't leak it.
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[deepnote-e2e] remove temp workspace dir during cleanup:', error);
        }
    });

    it('creates an environment, connects the kernel, runs the cell and renders output', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        const renderedOutput = await runOnceAndAwaitOutput(NOTEBOOK_FILE_NAME, EXPECTED_OUTPUT, FIRST_RUN_OUTPUT_TIMEOUT);
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });
});
