/**
 * E2E (ExTester): the full Deepnote happy path — open a one-notebook file, create + select an
 * environment (connects the kernel), run the cell, assert its stdout. Needs the Python extension + interpreter.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
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
    this.timeout(SUITE_TIMEOUT);

    // createEnvironment is idempotent, so a stable name lets a leftover env (and its provisioned venv)
    // from a retried or persistent run be reused rather than colliding.
    const environmentName = 'E2E Hello Env';

    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        // Work on a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp directory as a workspace folder FIRST: without one the serializer blocks
        // headlessly on a "Cannot read snapshot" warning, leaving the notebook blank. A workspace also
        // provides the requirements.txt the kernel auto-selector needs. (Opening a folder reloads the window.)
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

    it('creates an environment, connects the kernel, runs the cell and renders output', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName, NOTEBOOK_FILE_NAME);

        const renderedOutput = await runOnceAndAwaitOutput(
            NOTEBOOK_FILE_NAME,
            EXPECTED_OUTPUT,
            FIRST_RUN_OUTPUT_TIMEOUT
        );
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });
});
