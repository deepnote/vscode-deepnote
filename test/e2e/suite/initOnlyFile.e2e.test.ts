/**
 * E2E (ExTester): a `.deepnote` file whose only notebook IS its init notebook still opens as a
 * single-notebook file (renders that notebook as a fallback, no split prompt), and the Explorer
 * shows it as an openable single-notebook leaf (the init notebook is the sole notebook).
 */

import { expect } from 'chai';
import * as fs from 'fs';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    confirmModalDialog,
    copyFixtureToTempDir,
    createScreenshotter,
    findDeepnoteLeaf,
    getDeepnoteExplorerSection,
    openFolderViaDialog,
    openWorkspaceFile,
    readDeepnoteTreeRows,
    readStatusBarText,
    selectDeepnoteContextMenu,
    waitForNotification
} from '../helpers';

const FIXTURE = 'bootstrap-only.deepnote';
const NOTEBOOK_NAME = 'Bootstrap';
const SPLIT_PROMPT = /contains multiple notebooks/i;
const NO_SPLIT_PROMPT_TIMEOUT = 6_000;
const TREE_LOAD_TIMEOUT = 30_000;
const NOTEBOOK_NOT_FOUND = /Notebook not found/i;

describe('Deepnote — opening a file whose only notebook is the init notebook', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let editorOpened = false;
    let statusBarText = '';
    let splitPrompted = false;
    let notebookLeafShown = false;

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
        notebookLeafShown = (await readDeepnoteTreeRows(section)).some(
            (row) => row.isLeaf && row.label === NOTEBOOK_NAME
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

    it('shows the file as an openable notebook leaf in the Explorer', function () {
        expect(notebookLeafShown, 'an openable notebook leaf in the Deepnote Explorer').to.equal(true);
    });
});

/**
 * Notebook commands on an init-only leaf must resolve the init notebook (no "Notebook not found")
 * and delete must remove the file itself rather than emptying its notebooks array.
 */
describe('Deepnote — deleting an init-only leaf removes the whole file', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let tempDir = '';
    let filePath = '';
    let screenshot: (label: string) => Promise<string>;

    before(async function () {
        screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;
        filePath = copy.filePath;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        const section = await getDeepnoteExplorerSection();
        await VSBrowser.instance.driver
            .wait(async () => (await readDeepnoteTreeRows(section)).length > 0, TREE_LOAD_TIMEOUT)
            .catch(() => undefined);
        await screenshot('before-delete');
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

    it('deletes the file (init notebook resolves, no "Notebook not found")', async function () {
        const section = await getDeepnoteExplorerSection();
        const leaf = await findDeepnoteLeaf(section, NOTEBOOK_NAME);
        expect(leaf, `${NOTEBOOK_NAME} leaf`).to.not.equal(undefined);

        await selectDeepnoteContextMenu(leaf!, 'Delete Notebook');
        await confirmModalDialog('Delete', { messageIncludes: NOTEBOOK_NAME });

        const toast = await waitForNotification(new RegExp(`Notebook deleted: ${NOTEBOOK_NAME}`, 'i'), WORKBENCH_TIMEOUT, true);
        expect(toast, 'deleted toast').to.not.equal(undefined);
        await screenshot('after-delete');

        const notFound = await waitForNotification(NOTEBOOK_NOT_FOUND, NO_SPLIT_PROMPT_TIMEOUT, false);
        expect(notFound, 'no "Notebook not found" error').to.equal(undefined);

        expect(fs.existsSync(filePath), 'init-only file removed from disk').to.equal(false);
        expect(
            (await readDeepnoteTreeRows(section)).some((row) => row.isLeaf && row.label === NOTEBOOK_NAME),
            'the Bootstrap leaf no longer appears in the tree'
        ).to.equal(false);
    });
});
