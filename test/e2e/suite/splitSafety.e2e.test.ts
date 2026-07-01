/**
 * End-to-end UI test (ExTester / vscode-extension-tester) for the safety behaviour around the
 * multi-notebook split prompt:
 *   - Dismissing the prompt leaves the original file untouched (no siblings, no `.legacy`).
 *
 * Two further split-safety guarantees are exercised by the splitter's unit tests rather than here,
 * because neither can be driven reliably through the notebook UI in ExTester:
 *   - Dirty-flush-before-split (an unsaved in-cell edit is saved before the split) — see the pending
 *     `it.skip` below; ExTester cannot type into a rendered notebook cell.
 *   - Write-before-retire (the original is retired only after every child is written) — a failure path
 *     that cannot be forced through the UI at all.
 *
 * Screenshots are captured into `test/e2e/screenshots/splitSafety/`. Runs without a Python kernel.
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

        // Dismiss the prompt WITHOUT accepting the split.
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

    // Skipped: this check needs an UNSAVED, identifiable edit inside a notebook cell, and
    // ExTester/ChromeDriver cannot reliably drive typed text into one. Confirmed both WITHOUT and WITH a
    // bound Python kernel: clicking the cell and sending keys never lands the marker text — some control
    // keys (e.g. Enter) reach the buffer, but typed characters leak to the workbench toolbar instead of
    // the cell's input. (VS Code's current notebook cell input is EditContext-based, which Selenium's
    // synthetic character events do not feed.) The split prompt and the split action DO drive fine — a
    // dismissed prompt is covered above; only the in-cell text edit does not. The guarantee itself — a
    // dirty document is saved before the split, and the split aborts if that save fails — is covered
    // directly by the splitter's unit tests ("dirty gate (load-bearing safety)" in
    // deepnoteMultiNotebookSplitter.unit.test.ts).
    it.skip('flushes an unsaved edit to disk before splitting', function () {
        // Intended flow: open the multi-notebook file, dirty its rendered cell, accept the split, and
        // assert the unsaved edit reached the corresponding split child file on disk.
    });
});
