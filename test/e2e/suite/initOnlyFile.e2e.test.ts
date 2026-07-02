/**
 * E2E (ExTester): a `.deepnote` file whose only notebook IS its init notebook still opens as a
 * single-notebook file (renders that notebook as a fallback, no split prompt), and the Explorer
 * shows it with "0 notebooks" since the init notebook is excluded from the count.
 */

import { expect } from 'chai';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    getDeepnoteExplorerSection,
    openFolderViaDialog,
    openWorkspaceFile,
    readDeepnoteTreeRows,
    readStatusBarText,
    waitForNotification
} from '../helpers';

const FIXTURE = 'bootstrap-only.deepnote';
const NOTEBOOK_NAME = 'Bootstrap';
const SPLIT_PROMPT = /contains multiple notebooks/i;
const NO_SPLIT_PROMPT_TIMEOUT = 6_000;
const TREE_LOAD_TIMEOUT = 30_000;

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

        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            `${FIXTURE} did not open`
        );
        editorOpened = true;

        await driver.sleep(2000);
        await screenshot('opened');

        statusBarText = await readStatusBarText(NOTEBOOK_NAME);

        const prompt = await waitForNotification(SPLIT_PROMPT, NO_SPLIT_PROMPT_TIMEOUT, false);
        splitPrompted = prompt !== undefined;

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
