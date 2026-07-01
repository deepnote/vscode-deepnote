/**
 * End-to-end UI test (ExTester / vscode-extension-tester) for the edge case where a `.deepnote`
 * file's only notebook IS its init notebook (`project.initNotebookId` points at the sole notebook).
 * Such a file is still a single-notebook file, so opening it renders that notebook (as a fallback)
 * and does NOT raise the split prompt; the Explorer shows it with "0 notebooks" (the init notebook is
 * excluded from the count). Fixture: `bootstrap-only.deepnote` (its one notebook "Bootstrap" is the
 * init notebook).
 *
 * State is captured once in `before`; each `it` asserts one property. Runs without a Python kernel.
 */

import { expect } from 'chai';
import { EditorView, StatusBar, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    getDeepnoteExplorerSection,
    openFolderViaDialog,
    openWorkspaceFile,
    readDeepnoteTreeRows,
    waitForNotification
} from '../helpers';

const FIXTURE = 'bootstrap-only.deepnote';
const NOTEBOOK_NAME = 'Bootstrap';
const SPLIT_PROMPT = /contains multiple notebooks/i;
const NO_SPLIT_PROMPT_TIMEOUT = 6_000;
const STATUS_BAR_TIMEOUT = 10_000;
const TREE_LOAD_TIMEOUT = 30_000;

/** Reads the concatenated status-bar text, polling until it shows `expected`. */
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

describe('Deepnote — opening a file whose only notebook is the init notebook', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let editorOpened = false;
    let statusBarText = '';
    let splitPrompted = false;
    let zeroNotebooksNodeShown = false;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the file — it should render its single (init) notebook as a fallback.
        await openWorkspaceFile(FIXTURE);
        editorOpened = await driver
            .wait(
                async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
                WORKBENCH_TIMEOUT,
                `${FIXTURE} did not open`
            )
            .then(() => true)
            .catch(() => false);

        await driver.sleep(2000);
        await screenshot('opened');

        statusBarText = await readStatusBarText(NOTEBOOK_NAME);

        // A single-notebook file must NOT raise the split prompt.
        const prompt = await waitForNotification(SPLIT_PROMPT, NO_SPLIT_PROMPT_TIMEOUT, false);
        splitPrompted = prompt !== undefined;

        // The Explorer shows the file as a "0 notebooks" node (the init notebook is excluded).
        const section = await getDeepnoteExplorerSection();
        await driver
            .wait(async () => (await readDeepnoteTreeRows(section)).length > 0, TREE_LOAD_TIMEOUT)
            .catch(() => undefined);
        zeroNotebooksNodeShown = (await readDeepnoteTreeRows(section)).some((row) =>
            /0\s+notebooks?\b/.test(row.description)
        );
        await screenshot('explorer');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[init-only] remove temp workspace dir during cleanup:', error);
        }
    });

    it('opens the file directly in the notebook editor', function () {
        expect(editorOpened, `${FIXTURE} should open in the notebook editor`).to.equal(true);
    });

    it('renders the init notebook as a fallback (status bar shows its name)', function () {
        expect(statusBarText, `status bar should show "${NOTEBOOK_NAME}"`).to.contain(NOTEBOOK_NAME);
    });

    it('does not prompt to split (it is a single-notebook file)', function () {
        expect(splitPrompted, 'must not raise the split prompt').to.equal(false);
    });

    it('shows the file with "0 notebooks" in the Explorer (init excluded from the count)', function () {
        expect(zeroNotebooksNodeShown, 'a "0 notebooks" node in the Deepnote Explorer').to.equal(true);
    });
});
