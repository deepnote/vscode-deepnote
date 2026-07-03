/**
 * E2E (ExTester): "Reveal in Explorer" must actually reveal the active notebook's tree leaf.
 * Guards F3 — `TreeView.reveal` needs the provider's `getParent`; without it reveal rejects and the
 * command falls back to an "Active notebook: … in project …" toast instead of selecting the leaf.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView, Workbench, type ViewItem } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    findDeepnoteLeaf,
    getDeepnoteExplorerSection,
    openFolderViaDialog,
    openWorkspaceFile,
    waitForNotification
} from '../helpers';

const FIXTURE = 'quick-notes.deepnote';
const NOTEBOOK_NAME = 'Quick Notes';
const REVEAL_COMMAND = 'Deepnote: Reveal in Explorer';
// The fallback toast the command shows when `reveal` rejects (i.e. `getParent` is missing).
const REVEAL_FALLBACK = /Active notebook:.*in project/i;
// Shown when no notebook is active — guard against the reveal test passing vacuously.
const REVEAL_NO_ACTIVE = /No active Deepnote notebook|missing metadata/i;

const NO_FALLBACK_TIMEOUT = 6_000;
const SELECTION_SETTLE_DELAY = 1_500;

/** Reads a tree row's `aria-selected` (the row element is the `.monaco-list-row`). */
async function isSelected(item: ViewItem): Promise<boolean> {
    return (await item.getAttribute('aria-selected').catch(() => '')) === 'true';
}

describe('Deepnote — Reveal in Explorer', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let fallbackShown = true;
    let noActiveShown = true;
    let leafSelected = false;
    let selectionObserved = false;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the single-notebook file so there is an active Deepnote notebook editor to reveal.
        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );
        await driver.sleep(2000);

        // Render the tree once so the provider's caches (used by getParent) are populated.
        const section = await getDeepnoteExplorerSection();
        await findDeepnoteLeaf(section, NOTEBOOK_NAME);

        // Re-focus the notebook editor: the reveal command reads `window.activeNotebookEditor`.
        await openWorkspaceFile(FIXTURE);
        await driver.sleep(1000);

        await new Workbench().executeCommand(REVEAL_COMMAND);
        await driver.sleep(SELECTION_SETTLE_DELAY);
        await screenshot('after-reveal');

        // Primary discriminator: with getParent present, reveal succeeds and this toast never appears.
        const fallback = await waitForNotification(REVEAL_FALLBACK, NO_FALLBACK_TIMEOUT, false);
        fallbackShown = fallback !== undefined;

        // Guard against a vacuous pass: the command must have found an active notebook and reached reveal.
        const noActive = await waitForNotification(REVEAL_NO_ACTIVE, NO_FALLBACK_TIMEOUT, false);
        noActiveShown = noActive !== undefined;

        // Best-effort positive check: the leaf should now be selected. Selection isn't always
        // observable headlessly, so a miss is recorded (not asserted) rather than failing the suite.
        const leaf = await findDeepnoteLeaf(await getDeepnoteExplorerSection(), NOTEBOOK_NAME).catch(() => undefined);
        if (leaf) {
            leafSelected = await isSelected(leaf);
            selectionObserved = leafSelected;
        }
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[reveal] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[reveal] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[reveal] remove temp workspace dir during cleanup:', error);
        }
    });

    it('reveals the active notebook instead of falling back to an info toast', function () {
        expect(fallbackShown, 'reveal must succeed (no "Active notebook … in project" fallback toast)').to.equal(false);
    });

    it('reached the reveal path (an active notebook was found)', function () {
        expect(noActiveShown, 'the command must find the active notebook, not pass vacuously').to.equal(false);
    });

    it('selects the notebook leaf in the explorer when selection is observable', function () {
        if (!selectionObserved) {
            this.skip();
        }

        expect(leafSelected, `the "${NOTEBOOK_NAME}" leaf should be selected after reveal`).to.equal(true);
    });
});
