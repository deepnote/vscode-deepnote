/**
 * End-to-end UI test (ExTester / vscode-extension-tester) for the Deepnote Explorer's project
 * grouping. Sibling `.deepnote` files that share one `project.id` must collapse into a single
 * project group; files from a different project must appear as their own separate group.
 *
 * The workspace holds three "Marketing" siblings (`marketing-overview/campaigns/metrics.deepnote`,
 * one shared `project.id`) plus an unrelated single-notebook file (`quick-notes.deepnote`). The
 * tree is read once in `before`; each `it` asserts one property. Screenshots are captured into
 * `test/e2e/screenshots/explorerGrouping/`. Runs without a Python kernel.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { ActivityBar, EditorView, SideBarView, VSBrowser, WebView, type ViewItem } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    openFolderViaDialog
} from '../helpers';

const MARKETING_FILES = ['marketing-overview.deepnote', 'marketing-campaigns.deepnote', 'marketing-metrics.deepnote'];
const OTHER_PROJECT_FILE = 'quick-notes.deepnote';

const MARKETING_GROUP = 'Marketing';
const OTHER_GROUP = 'Quick Notes';
const EXPECTED_NOTEBOOKS = ['Campaigns', 'Metrics', 'Overview']; // the three leaves, sorted

const TREE_LOAD_TIMEOUT = 30_000;

interface TreeRow {
    item: ViewItem;
    label: string;
    description: string;
    /** A project group reads "N files"; a notebook leaf reads "N cells". */
    isGroup: boolean;
    isLeaf: boolean;
}

/** Reads the label of a tree item, tolerating a transient stale-element error. */
async function labelOf(item: ViewItem): Promise<string> {
    return (item as unknown as { getLabel(): Promise<string> }).getLabel().catch(() => '');
}

/** Reads the description ("3 files" / "2 cells") of a tree item. */
async function descriptionOf(item: ViewItem): Promise<string> {
    const description = await (item as unknown as { getDescription(): Promise<string | undefined> })
        .getDescription()
        .catch(() => '');

    return description ?? '';
}

/** The Deepnote Explorer tree section (named "Explorer" inside the Deepnote view container). */
async function getExplorerSection() {
    const content = new SideBarView().getContent();
    const named = await content.getSection('Explorer').catch(() => undefined);

    return named ?? (await content.getSections())[0];
}

/** Reads the currently-visible tree rows, classifying each as a project group or a notebook leaf. */
async function readRows(section: Awaited<ReturnType<typeof getExplorerSection>>): Promise<TreeRow[]> {
    const rows: TreeRow[] = [];

    for (const item of await section.getVisibleItems().catch(() => [] as ViewItem[])) {
        const description = await descriptionOf(item);

        rows.push({
            item,
            label: await labelOf(item),
            description,
            isGroup: /\d+\s+files?\b/.test(description),
            isLeaf: /\d+\s+cells?\b/.test(description)
        });
    }

    return rows;
}

describe('Deepnote — the Explorer groups sibling files by project', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let marketingDescription = '';
    let marketingChildren: string[] = [];
    let groupLabels: string[] = [];

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        // Put all four files (three Marketing siblings + one unrelated project) in one workspace.
        const copy = copyFixtureToTempDir(MARKETING_FILES[0]);
        cleanupTempDir = copy.cleanup;
        for (const name of [...MARKETING_FILES.slice(1), OTHER_PROJECT_FILE]) {
            fs.copyFileSync(
                path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', name),
                path.join(copy.tempDir, name)
            );
        }

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the Deepnote view container and grab its Explorer tree section.
        const control = await new ActivityBar().getViewControl('Deepnote');
        await control?.openView();
        await driver.sleep(2000);
        const section = await getExplorerSection();

        // Wait for the workspace scan to surface the Marketing group.
        await driver.wait(
            async () => (await readRows(section)).some((row) => row.label === MARKETING_GROUP && row.isGroup),
            TREE_LOAD_TIMEOUT,
            'the "Marketing" project group did not appear in the Deepnote Explorer'
        );
        await screenshot('explorer-groups');

        // With Marketing still collapsed, record the project groups and the currently-visible leaves.
        const collapsed = await readRows(section);
        groupLabels = collapsed
            .filter((row) => row.isGroup)
            .map((row) => row.label)
            .sort();
        marketingDescription = collapsed.find((row) => row.label === MARKETING_GROUP && row.isGroup)?.description ?? '';
        const leavesBefore = new Set(collapsed.filter((row) => row.isLeaf).map((row) => row.label));

        // Expand Marketing; the leaves that newly appear are exactly its notebooks (avoids the
        // library's flaky CustomTreeItem.getChildItems).
        const marketing = collapsed.find((row) => row.label === MARKETING_GROUP && row.isGroup)?.item;
        await (marketing as unknown as { expand(): Promise<void> } | undefined)?.expand();
        await driver.sleep(1000);
        await screenshot('marketing-expanded');

        const expanded = await readRows(section);
        marketingChildren = expanded
            .filter((row) => row.isLeaf && !leavesBefore.has(row.label))
            .map((row) => row.label)
            .sort();
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[explorer] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[explorer] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[explorer] remove temp workspace dir during cleanup:', error);
        }
    });

    it('collapses the three same-project files into one project group labelled "3 files"', function () {
        expect(marketingDescription, 'Marketing group description').to.match(/3\s+files/);
        expect(groupLabels, 'Marketing appears once as a group').to.include(MARKETING_GROUP);
    });

    it('lists each notebook as a leaf under the project group', function () {
        expect(marketingChildren, 'notebooks revealed by expanding Marketing').to.deep.equal(EXPECTED_NOTEBOOKS);
    });

    it('shows a file from a different project as its own separate group', function () {
        expect(groupLabels, 'top-level project groups').to.include.members([MARKETING_GROUP, OTHER_GROUP]);
    });
});
