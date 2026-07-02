/**
 * E2E test for split-prompt safety: dismissing the prompt leaves the original file untouched (no
 * siblings, no `.legacy`). The dirty-flush-before-split and write-before-retire guarantees are
 * covered by the splitter's unit tests, since neither can be driven reliably through the ExTester UI.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    waitForNotification
} from '../helpers';

const DISMISS_FIXTURE = 'sales-analytics.deepnote';
const SPLIT_PROMPT = /contains multiple notebooks/i;

describe('Deepnote — split-prompt safety', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let tempDir = '';

    before(async function () {
        const copy = copyFixtureToTempDir(DISMISS_FIXTURE);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[split-safety] remove temp workspace dir during cleanup:', error);
        }
    });

    it('leaves the original file untouched when the split prompt is dismissed', async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        await openWorkspaceFile(DISMISS_FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(DISMISS_FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${DISMISS_FIXTURE} did not open`
        );

        const prompt = await waitForNotification(SPLIT_PROMPT, WORKBENCH_TIMEOUT, true);
        expect(prompt, 'split prompt notification').to.not.equal(undefined);
        await screenshot('prompt-shown');

        await prompt!.dismiss().catch((error) => console.warn('[split-safety] dismiss prompt:', error));
        await driver.sleep(2000);
        await screenshot('after-dismiss');

        const deepnoteFiles = fs.readdirSync(tempDir).filter((file) => file.endsWith('.deepnote'));
        expect(fs.existsSync(path.join(tempDir, DISMISS_FIXTURE)), 'original still present').to.equal(true);
        expect(
            deepnoteFiles.some((file) => file.startsWith('sales-analytics-')),
            'no split sibling files created'
        ).to.equal(false);
        expect(fs.existsSync(path.join(tempDir, `${DISMISS_FIXTURE}.legacy`)), 'no .legacy backup created').to.equal(
            false
        );
    });

    // Skipped: needs typed text in a notebook cell, but VS Code's cell input is EditContext-based and
    // Selenium's synthetic character events don't reach it. Covered by the splitter's unit tests.
    it.skip('flushes an unsaved edit to disk before splitting', function () {});
});
