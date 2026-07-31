/**
 * E2E (ExTester): renaming a project group in the Explorer fans the new name out to EVERY sibling
 * `.deepnote` on disk (siblings share one `project.id`), including ones never opened — and saves an
 * open, DIRTY sibling first so its unsaved cell edits survive instead of being clobbered by the
 * file-watcher reload the rewrite triggers.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { By, EditorView, InputBox, VSBrowser, WebView, type ViewItem } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    findDeepnoteGroup,
    getDeepnoteExplorerSection,
    openFolderViaDialog,
    openWorkspaceFile,
    readDeepnoteTreeRows,
    selectDeepnoteContextMenu,
    waitForNotification
} from '../helpers';

const DIRTIED_FILE = 'marketing-overview.deepnote' as const;
const MARKETING_FILES = [DIRTIED_FILE, 'marketing-campaigns.deepnote', 'marketing-metrics.deepnote'] as const;
const OLD_NAME = 'Marketing';
const NEW_NAME = 'Growth';
const DIRTY_MARKER = 'zzdirtyeditzz';
const TREE_LOAD_TIMEOUT = 30_000;

/**
 * Opens {@link DIRTIED_FILE} and types {@link DIRTY_MARKER} into its first code cell WITHOUT saving,
 * leaving the notebook document dirty. Resolves once the edit has registered in the cell overlay.
 */
async function leaveUnsavedCellEdit(): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await openWorkspaceFile(DIRTIED_FILE);

    // Click the first CODE cell's source line to focus its editor (markdown cells have none); locate
    // and click in one retried step, since the cell re-renders on open and can stale a prior reference.
    await driver.wait(
        async () => {
            const line = (await driver.findElements(By.css('.notebookOverlay .code-cell-row .view-line')))[0];

            if (!line) {
                return false;
            }

            try {
                await line.click();

                return true;
            } catch {
                return false;
            }
        },
        WORKBENCH_TIMEOUT,
        'the notebook code cell did not render or settle enough to focus'
    );
    await driver.sleep(400);
    await driver.switchTo().activeElement().sendKeys(DIRTY_MARKER);

    // Confirm the edit landed (the cell now shows the marker) before we rename, so a focus/typing
    // miss fails here with a clear message instead of masquerading as a lost-edit regression later.
    await driver.wait(
        async () => {
            const text = await driver.executeScript<string>(() => {
                const parts: string[] = [];
                document
                    .querySelectorAll('.notebookOverlay .code-cell-row .view-line')
                    .forEach((el) => parts.push((el as HTMLElement).textContent ?? ''));

                return parts.join('\n');
            });

            return text.includes(DIRTY_MARKER);
        },
        WORKBENCH_TIMEOUT,
        `the unsaved cell edit "${DIRTY_MARKER}" did not register`
    );
}

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

        let section = await getDeepnoteExplorerSection();
        await driver.wait(
            async () => (await readDeepnoteTreeRows(section)).some((row) => row.label === OLD_NAME && row.isGroup),
            TREE_LOAD_TIMEOUT,
            `the "${OLD_NAME}" project group did not appear`
        );
        await screenshot('before-rename');

        await leaveUnsavedCellEdit();

        // Opening the notebook moved focus to the editor; re-open the Explorer before driving the tree.
        section = await getDeepnoteExplorerSection();
        const group = await findDeepnoteGroup(section, OLD_NAME);
        if (!group) {
            throw new Error(`"${OLD_NAME}" project group not found`);
        }

        await selectDeepnoteContextMenu(group, 'Rename Project');
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

    it('saves an open, dirty sibling before renaming instead of discarding the edit', function () {
        const dirtied = fileContents[MARKETING_FILES.indexOf(DIRTIED_FILE)];

        // Flushed to disk first: the unsaved marker survived instead of being clobbered by the reload.
        expect(dirtied, 'the unsaved cell edit was saved before the rename rewrite').to.contain(DIRTY_MARKER);
        // ...and the dirtied sibling still received the new project name.
        expect(dirtied, 'the dirtied sibling still received the new project name').to.contain(`name: ${NEW_NAME}`);
    });
});
