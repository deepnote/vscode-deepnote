/**
 * E2E (ExTester): the status-bar item shows the active Deepnote notebook's name, copies its details
 * to the clipboard on click, and hides for a non-notebook editor. Fixture: `quick-notes.deepnote`.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { By, EditorView, Key, StatusBar, TextEditor, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    waitForNotification
} from '../../helpers';

const FIXTURE = 'quick-notes.deepnote';
const SCRATCH_FILE = 'clipboard-scratch.txt';
const NOTEBOOK_NAME = 'Quick Notes';
const NOTEBOOK_ID = 'c-nb-main';
const COPIED_TOAST = /Copied Deepnote notebook details to clipboard\./i;

/** Finds the Deepnote status-bar item by the notebook name in its text. */
async function findDeepnoteStatusItem() {
    const items = await new StatusBar().getItems().catch(() => []);

    for (const item of items) {
        const text = await item.getText().catch(() => '');

        if (text.includes(NOTEBOOK_NAME)) {
            return item;
        }
    }

    return undefined;
}

/** Reads the OS clipboard from the Electron renderer; empty string if unavailable under automation. */
async function readClipboardViaRenderer(): Promise<string> {
    const text = await VSBrowser.instance.driver
        .executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             try { navigator.clipboard.readText().then((t) => done(t || '')).catch(() => done('')); }
             catch (error) { done(''); }`
        )
        .catch(() => '');

    return typeof text === 'string' ? text : '';
}

describe('Deepnote — the active-notebook status bar item', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let projectId = '';
    let itemTextWithNotebook = '';
    let itemTooltip = '';
    let copyToastShown = false;
    let clipboardText = '';
    let itemVisibleWithNonNotebook = true;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(FIXTURE);
        projectId = copy.projectId;
        cleanupTempDir = copy.cleanup;
        // A plain, non-notebook editor to paste the clipboard into (also serves the hidden-item check).
        fs.writeFileSync(path.join(copy.tempDir, SCRATCH_FILE), '');

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );
        await driver.sleep(2000);

        const item = await driver.wait(async () => findDeepnoteStatusItem(), WORKBENCH_TIMEOUT).catch(() => undefined);
        itemTextWithNotebook = item ? await item.getText().catch(() => '') : '';
        itemTooltip = item ? (await item.getAttribute('aria-label').catch(() => '')) ?? '' : '';
        await screenshot('notebook-focused');

        await item?.click().catch((error) => console.warn('[status] click status item:', error));
        const toast = await waitForNotification(COPIED_TOAST, WORKBENCH_TIMEOUT, false);
        copyToastShown = toast !== undefined;

        // Prefer the renderer's clipboard API; fall back to pasting into the scratch editor below.
        clipboardText = await readClipboardViaRenderer();

        await openWorkspaceFile(SCRATCH_FILE);
        await driver.sleep(1200);

        if (!clipboardText.includes(NOTEBOOK_NAME)) {
            const editorBody = await driver
                .findElement(By.css('.editor-instance .monaco-editor'))
                .catch(() => undefined);
            if (editorBody) {
                await driver
                    .actions()
                    .move({ origin: editorBody })
                    .click()
                    .perform()
                    .catch((error) => console.warn('[status] focus editor:', error));
            }
            await driver.sleep(300);
            await driver
                .actions()
                .keyDown(Key.CONTROL)
                .sendKeys('v')
                .keyUp(Key.CONTROL)
                .perform()
                .catch((error) => console.warn('[status] paste via actions:', error));
            await driver.sleep(700);
            clipboardText = await new TextEditor().getText().catch(() => clipboardText);
        }
        await screenshot('clipboard-read');

        // With the scratch (non-notebook) editor active, the Deepnote status item must be hidden.
        await driver.sleep(1000);
        itemVisibleWithNonNotebook = (await findDeepnoteStatusItem()) !== undefined;
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[status] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[status] remove temp workspace dir during cleanup:', error);
        }
    });

    it('shows the active notebook name in the status bar', function () {
        expect(itemTextWithNotebook, 'status bar item text').to.contain(NOTEBOOK_NAME);
    });

    it('labels the status bar item with the copy-details tooltip', function () {
        expect(itemTooltip, 'status bar item tooltip/aria-label').to.contain('Copy Active Deepnote Notebook Details');
    });

    it('hides the status bar item when a non-notebook editor is focused', function () {
        expect(itemVisibleWithNonNotebook, 'status item hidden for non-notebook editor').to.equal(false);
    });

    it('copies the notebook details to the clipboard and confirms with a toast', function () {
        expect(copyToastShown, 'copied-to-clipboard toast').to.equal(true);
        expect(clipboardText, 'clipboard details').to.contain(`Notebook name: ${NOTEBOOK_NAME}`);
        expect(clipboardText, 'clipboard details').to.contain(`Notebook ID: ${NOTEBOOK_ID}`);
        expect(clipboardText, 'clipboard details').to.contain(`Project ID: ${projectId}`);
        expect(clipboardText, 'clipboard details').to.contain(FIXTURE);
    });
});
