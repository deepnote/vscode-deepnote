/**
 * E2E (ExTester): opening a plain single-notebook `.deepnote` file renders its one notebook
 * directly, raises no split prompt, and shows the notebook name in the status bar.
 */

import { expect } from 'chai';
import { EditorView, StatusBar, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    waitForNotification
} from '../helpers';

const FIXTURE = 'quick-notes.deepnote';
const NOTEBOOK_NAME = 'Quick Notes';
const SPLIT_PROMPT = /contains multiple notebooks/i;

const NO_SPLIT_PROMPT_TIMEOUT = 6_000;
const STATUS_BAR_TIMEOUT = 10_000;

/** Reads the concatenated text of all status-bar items, polling until it shows `expected`. */
async function readStatusBarText(expected: string): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + STATUS_BAR_TIMEOUT;
    let joined = '';

    while (Date.now() < deadline) {
        const items = await new StatusBar().getItems().catch(() => [] as never[]);
        const texts = await Promise.all(items.map((item) => item.getText().catch(() => '')));
        joined = texts.join(' | ');

        if (joined.includes(expected)) {
            return joined;
        }

        await driver.sleep(500);
    }

    return joined;
}

describe('Deepnote — opening a plain single-notebook .deepnote file', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let editorOpened = false;
    let splitPrompted = false;
    let statusBarText = '';

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp dir as workspace root first: the serializer reads snapshots relative to a
        // workspace folder, else deserialization blocks headlessly. Opening a folder reloads the window.
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );
        editorOpened = true;

        await driver.sleep(2000);
        await screenshot('single-notebook-open');

        const prompt = await waitForNotification(SPLIT_PROMPT, NO_SPLIT_PROMPT_TIMEOUT, false);
        splitPrompted = prompt !== undefined;

        statusBarText = await readStatusBarText(NOTEBOOK_NAME);
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[single] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[single] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[single] remove temp workspace dir during cleanup:', error);
        }
    });

    it('opens the single-notebook file directly in the notebook editor', function () {
        expect(editorOpened, `${FIXTURE} should open in the notebook editor`).to.equal(true);
    });

    it('does not prompt to split a single-notebook file', function () {
        expect(splitPrompted, 'a single-notebook file must not raise the split prompt').to.equal(false);
    });

    it('shows the active notebook name in the status bar', function () {
        expect(statusBarText, `status bar should show "${NOTEBOOK_NAME}"`).to.contain(NOTEBOOK_NAME);
    });
});
