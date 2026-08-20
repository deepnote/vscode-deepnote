/**
 * E2E (ExTester): New/Add/Duplicate/Rename/Delete commands create, rename, and delete sibling
 * `.deepnote` files; filenames are derived, so assertions check the notebook NAME. Delete is permanent.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
    ActivityBar,
    By,
    EditorView,
    InputBox,
    SideBarView,
    VSBrowser,
    WebElement,
    WebView,
    Workbench,
    type ViewItem
} from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    confirmModalDialog,
    copyFixtureIntoDir,
    copyFixtureToTempDir,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile,
    assertNotNull,
    waitForNotification
} from '../helpers';

const MARKETING_FILES = ['marketing-overview.deepnote', 'marketing-campaigns.deepnote', 'marketing-metrics.deepnote'];
const GROUP = 'Marketing';
const TREE_LOAD_TIMEOUT = 30_000;

interface TreeRow {
    item: ViewItem;
    label: string;
    isGroup: boolean;
    isLeaf: boolean;
}

async function labelOf(item: ViewItem): Promise<string> {
    return (item as unknown as { getLabel(): Promise<string> }).getLabel().catch(() => '');
}

async function descriptionOf(item: ViewItem): Promise<string> {
    const description = await (item as unknown as { getDescription(): Promise<string | undefined> })
        .getDescription()
        .catch(() => '');

    return description ?? '';
}

async function getExplorerSection() {
    const control = await new ActivityBar().getViewControl('Deepnote');
    await control?.openView();
    await VSBrowser.instance.driver.sleep(1200);
    const content = new SideBarView().getContent();
    const named = await content.getSection('Explorer').catch(() => undefined);

    return named ?? (await content.getSections())[0];
}

async function readRows(section: Awaited<ReturnType<typeof getExplorerSection>>): Promise<TreeRow[]> {
    const rows: TreeRow[] = [];

    for (const item of await section.getVisibleItems().catch(() => [] as ViewItem[])) {
        const description = await descriptionOf(item);
        rows.push({
            item,
            label: await labelOf(item),
            isGroup: /\d+\s+files?\b/.test(description),
            isLeaf: /\d+\s+cells?\b/.test(description)
        });
    }

    return rows;
}

async function findGroup(section: Awaited<ReturnType<typeof getExplorerSection>>): Promise<ViewItem | undefined> {
    return (await readRows(section)).find((row) => row.label === GROUP && row.isGroup)?.item;
}

/** Expands the Marketing group first, then finds a notebook leaf by name. */
async function findLeaf(
    section: Awaited<ReturnType<typeof getExplorerSection>>,
    label: string
): Promise<ViewItem | undefined> {
    const group = await findGroup(section);
    await (group as unknown as { expand(): Promise<void> } | undefined)?.expand().catch(() => undefined);
    await VSBrowser.instance.driver.sleep(800);

    return (await readRows(section)).find((row) => row.label === label && row.isLeaf)?.item;
}

/**
 * Right-clicks a tree item and invokes a context-menu command by label via raw DOM, since ExTester's
 * ContextMenu model re-queries `.monaco-menu` lazily and throws for modal-opening commands.
 */
async function contextSelect(item: ViewItem, command: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await driver
        .actions()
        .contextClick(item as unknown as WebElement)
        .perform();
    await driver.sleep(500);

    const menuItem = await driver.wait(
        async () => {
            for (const element of await driver.findElements(By.css('.monaco-menu .action-label')).catch(() => [])) {
                if ((await element.getText().catch(() => '')).trim() === command) {
                    return element;
                }
            }

            return undefined;
        },
        WORKBENCH_TIMEOUT,
        `context menu item "${command}" did not appear`
    );
    if (!menuItem) {
        throw new Error(`context menu item "${command}" not found`);
    }
    await driver.actions().move({ origin: menuItem }).click().perform();
}

function hasFileWithNotebookName(dir: string, notebookName: string): boolean {
    return fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.deepnote'))
        .some((file) => fs.readFileSync(path.join(dir, file), 'utf8').includes(`name: ${notebookName}`));
}

function listDeepnoteFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter((file) => file.endsWith('.deepnote'));
}

/** True when the group's notebook leaves are visible, i.e. the group is expanded (not collapsed). */
async function groupIsExpanded(section: Awaited<ReturnType<typeof getExplorerSection>>): Promise<boolean> {
    return (await readRows(section)).some((row) => row.isLeaf);
}

describe('Deepnote — notebook-management commands create and remove sibling files', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let tempDir = '';
    let screenshot: (label: string) => Promise<string>;

    before(async function () {
        screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(MARKETING_FILES[0]);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;
        for (const name of MARKETING_FILES.slice(1)) {
            copyFixtureIntoDir(tempDir, name);
        }

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        const section = await getExplorerSection();
        await VSBrowser.instance.driver.wait(
            async () => (await readRows(section)).some((row) => row.label === GROUP && row.isGroup),
            TREE_LOAD_TIMEOUT,
            'the "Marketing" project group did not appear'
        );
        await screenshot('marketing-group');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[commands] remove temp workspace dir during cleanup:', error);
        }
    });

    it('creates a new sibling file via "New Notebook" (active notebook editor)', async function () {
        await openWorkspaceFile('marketing-overview.deepnote');
        await VSBrowser.instance.driver.sleep(1500);

        await new Workbench().executeCommand('Deepnote: New Notebook');
        const input = await InputBox.create(WORKBENCH_TIMEOUT);
        await input.setText('Analysis');
        await input.confirm();

        const toast = await waitForNotification(/Created new notebook: Analysis/i, WORKBENCH_TIMEOUT, true);
        expect(toast, 'created toast').to.not.equal(undefined);
        expect(hasFileWithNotebookName(tempDir, 'Analysis'), 'a sibling file holding "Analysis"').to.equal(true);

        // The new file is named from the project ("Marketing" → `marketing-analysis.deepnote`), NOT from
        // the active file's stem (`marketing-overview`) — otherwise the filename accumulates other names.
        expect(
            listDeepnoteFiles(tempDir),
            'new sibling must be marketing-analysis.deepnote, not marketing-overview-analysis.deepnote'
        ).to.include('marketing-analysis.deepnote');
    });

    it('creates a new sibling file via "Add Notebook" named from the project name', async function () {
        const section = await getExplorerSection();
        const group = assertNotNull(await findGroup(section), 'Marketing group tree item');

        // Expand the multi-file group first: "Add Notebook" must keep the group usable/expanded, not
        // send the whole tree back through a loading rebuild. (The scoped-vs-full refresh that prevents
        // a collapse is asserted deterministically in the DeepnoteExplorerView unit tests — VS Code
        // restores group-level expansion by id, so the teardown is a transient the UI can't reliably show.)
        await (group as unknown as { expand(): Promise<void> }).expand().catch(() => undefined);
        await VSBrowser.instance.driver.sleep(800);

        await contextSelect(group, 'Add Notebook');
        const input = await InputBox.create(WORKBENCH_TIMEOUT);
        await input.setText('Extra');
        await input.confirm();

        const toast = await waitForNotification(/Created new notebook: Extra/i, WORKBENCH_TIMEOUT, true);
        expect(toast, 'created toast').to.not.equal(undefined);
        expect(hasFileWithNotebookName(tempDir, 'Extra'), 'a sibling file holding "Extra"').to.equal(true);

        // The filename is `{projectSlug}-{notebookSlug}` from the project name ("Marketing" →
        // `marketing-extra.deepnote`), never a compound of a sibling's stem (`marketing-analysis-extra`).
        const files = listDeepnoteFiles(tempDir);
        expect(files, 'new sibling is named from the project name').to.include('marketing-extra.deepnote');
        expect(
            files.filter((file) => /-extra\.deepnote$/.test(file)),
            'exactly one "-extra" sibling, with no accumulated notebook names'
        ).to.deep.equal(['marketing-extra.deepnote']);

        // The group is still present and browsable after the add (not stuck on a loading node).
        expect(await groupIsExpanded(section), 'group leaves remain visible after Add Notebook').to.equal(true);
    });

    it('duplicates a notebook into a new sibling file', async function () {
        const section = await getExplorerSection();
        const overview = assertNotNull(await findLeaf(section, 'Overview'), 'Overview leaf');

        await contextSelect(overview, 'Duplicate Notebook');

        const toast = await waitForNotification(/Notebook duplicated: Overview \(Copy\)/i, WORKBENCH_TIMEOUT, true);
        expect(toast, 'duplicated toast').to.not.equal(undefined);
        expect(
            hasFileWithNotebookName(tempDir, 'Overview (Copy)'),
            'a sibling file holding "Overview (Copy)"'
        ).to.equal(true);
        expect(fs.existsSync(path.join(tempDir, 'marketing-overview.deepnote')), 'original overview file').to.equal(
            true
        );
    });

    it('renames the notebook inside the file, not the file', async function () {
        const section = await getExplorerSection();
        const campaigns = assertNotNull(await findLeaf(section, 'Campaigns'), 'Campaigns leaf');

        await contextSelect(campaigns, 'Rename Notebook');
        const input = await InputBox.create(WORKBENCH_TIMEOUT);
        await input.setText('Campaign Report');
        await input.confirm();

        const toast = await waitForNotification(/Notebook renamed to: Campaign Report/i, WORKBENCH_TIMEOUT, true);
        expect(toast, 'renamed toast').to.not.equal(undefined);

        const filePath = path.join(tempDir, 'marketing-campaigns.deepnote');
        expect(fs.existsSync(filePath), 'marketing-campaigns.deepnote still exists').to.equal(true);
        expect(fs.readFileSync(filePath, 'utf8'), 'notebook renamed inside the file').to.contain(
            'name: Campaign Report'
        );
    });

    it('deletes the whole single-notebook file after a modal confirmation', async function () {
        const section = await getExplorerSection();
        const metrics = assertNotNull(await findLeaf(section, 'Metrics'), 'Metrics leaf');

        await contextSelect(metrics, 'Delete Notebook');

        // Confirm the `{modal:true}` dialog via raw DOM: ExTester's ModalDialog matches buttons by a
        // `title` attribute the dialog doesn't set; the message guard targets the right dialog.
        await confirmModalDialog('Delete', { messageIncludes: 'Metrics' });

        const toast = await waitForNotification(/Notebook deleted: Metrics/i, WORKBENCH_TIMEOUT, true);
        expect(toast, 'deleted toast').to.not.equal(undefined);
        await screenshot('after-delete');
        expect(fs.existsSync(path.join(tempDir, 'marketing-metrics.deepnote')), 'metrics file removed').to.equal(false);
    });
});
