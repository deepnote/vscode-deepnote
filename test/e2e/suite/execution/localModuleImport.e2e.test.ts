/**
 * Covers the kernel's `sys.path`: the toolkit strips the notebook's folder from it when the server is started with
 * the legacy `DEEPNOTE_PROJECT_ID`.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
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

const NOTEBOOK_FILE_NAME = 'local-module-import.deepnote';
const EXPECTED_OUTPUT = 'local helper imported';

describe('Deepnote E2E — import a module next to the `.deepnote` file', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;

    before(async function () {
        const { cleanup, tempDir } = copyFixtureToTempDir(NOTEBOOK_FILE_NAME);
        cleanupTempDir = cleanup;

        fs.writeFileSync(path.join(tempDir, 'local_helper.py'), `MARKER = '${EXPECTED_OUTPUT}'\n`);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // The serializer's snapshot read blocks headlessly without a workspace folder, so open the folder first.
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

    it('imports `local_helper` from the notebook folder', async function () {
        const output = await runOnceAndAwaitOutput(NOTEBOOK_FILE_NAME, EXPECTED_OUTPUT, FIRST_RUN_OUTPUT_TIMEOUT);
        expect(output).to.contain(EXPECTED_OUTPUT);
    });
});
