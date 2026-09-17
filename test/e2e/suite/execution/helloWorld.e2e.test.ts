/**
 * End-to-end UI test driven by ExTester (vscode-extension-tester).
 *
 * It exercises the full Deepnote happy path through the *real* VS Code UI:
 *   1. open a one-notebook `.deepnote` file containing `print("hello world")`
 *   2. run the cell (the notebook toolbar's "Run All" button) — the click is what starts the
 *      kernel, since the controller registered on open connects lazily on first execution
 *   3. assert the rendered stdout output contains "hello world"
 *
 * The reusable interaction helpers live in `test/e2e/helpers/`; this file is only the suite wiring.
 *
 * Prerequisites:
 *   - The Python extension (`ms-python.python`) must be installed in the test instance
 *     (`npm run setup:e2e:deps`).
 *   - The active interpreter must already provide deepnote-toolkit. `npm run setup:e2e:venv` bakes
 *     it into `.venv-e2e` and pins that interpreter for every workspace; without it the run stops on
 *     the install-consent prompt.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    openFolderViaDialog,
    openWorkspaceFile,
    runOnceAndAwaitOutput
} from '../../helpers';

const NOTEBOOK_FILE_NAME = 'hello-world.deepnote';
const EXPECTED_OUTPUT = 'hello world';

describe('Deepnote E2E — run "hello world"', function () {
    // Per-test timeout for the whole suite (overrides the mocharc default for these tests).
    this.timeout(SUITE_TIMEOUT);

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

    it('connects the kernel on first run and renders the cell output', async function () {
        const renderedOutput = await runOnceAndAwaitOutput(NOTEBOOK_FILE_NAME, EXPECTED_OUTPUT, FIRST_RUN_OUTPUT_TIMEOUT);
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });
});
