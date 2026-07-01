/**
 * End-to-end UI test (ExTester / vscode-extension-tester) for renaming a Deepnote project from the
 * Explorer. A project's siblings share one `project.id`; renaming the project group must fan the new
 * name out to EVERY sibling `.deepnote` file on disk — including ones that were never opened. Uses
 * the three "Marketing" siblings (one shared project.id), none of which is opened as a notebook.
 *
 * The rename runs once in `before`; each `it` asserts one property. Screenshots are captured into
 * `test/e2e/screenshots/projectRename/`. Runs without a Python kernel.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, InputBox, VSBrowser, WebView, type ViewItem } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    findDeepnoteGroup,
    getDeepnoteExplorerSection,
    openFolderViaDialog,
    readDeepnoteTreeRows,
    selectDeepnoteContextMenu,
    waitForNotification
} from '../helpers';

const MARKETING_FILES = ['marketing-overview.deepnote', 'marketing-campaigns.deepnote', 'marketing-metrics.deepnote'];
const OLD_NAME = 'Marketing';
const NEW_NAME = 'Growth';
const TREE_LOAD_TIMEOUT = 30_000;

describe('Deepnote — renaming a project fans the new name out to every sibling file', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let tempDir = '';
    let renameToastShown = false;
    let groupLabelAfter = '';
    let fileContents: string[] = [];

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(MARKETING_FILES[0]);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;
        for (const name of MARKETING_FILES.slice(1)) {
            fs.copyFileSync(path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', name), path.join(tempDir, name));
        }

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // None of the notebooks is opened — only the tree is used, so this proves the rename reaches
        // closed siblings on disk.
        const section = await getDeepnoteExplorerSection();
        await driver.wait(
            async () => (await readDeepnoteTreeRows(section)).some((row) => row.label === OLD_NAME && row.isGroup),
            TREE_LOAD_TIMEOUT,
            `the "${OLD_NAME}" project group did not appear`
        );
        await screenshot('before-rename');

        const group = await findDeepnoteGroup(section, OLD_NAME);
        if (!group) {
            throw new Error(`"${OLD_NAME}" project group not found`);
        }

        await selectDeepnoteContextMenu(group as ViewItem, 'Rename Project');
        const input = await InputBox.create(WORKBENCH_TIMEOUT);
        await input.setText(NEW_NAME);
        await input.confirm();

        const toast = await waitForNotification(/Project renamed to: Growth/i, WORKBENCH_TIMEOUT, true);
        renameToastShown = toast !== undefined;
        await driver.sleep(1500);
        await screenshot('after-rename');

        fileContents = MARKETING_FILES.map((file) => fs.readFileSync(path.join(tempDir, file), 'utf8'));
        groupLabelAfter = (await readDeepnoteTreeRows(section)).find((row) => row.isGroup)?.label ?? '';
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[rename] remove temp workspace dir during cleanup:', error);
        }
    });

    it('confirms the rename with a toast', function () {
        expect(renameToastShown, 'project-renamed toast').to.equal(true);
    });

    it('writes the new project name into every sibling file on disk', function () {
        MARKETING_FILES.forEach((file, index) => {
            expect(fileContents[index], `${file} has the new project name`).to.contain(`name: ${NEW_NAME}`);
            expect(fileContents[index], `${file} no longer has the old project name`).to.not.contain(
                `name: ${OLD_NAME}`
            );
        });
    });

    it('relabels the project group in the Explorer', function () {
        expect(groupLabelAfter, 'group label after rename').to.equal(NEW_NAME);
    });
});
