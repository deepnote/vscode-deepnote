import { ActivityBar, By, SideBarView, VSBrowser, WebElement, type ViewItem } from 'vscode-extension-tester';

import { WORKBENCH_TIMEOUT } from './constants';

/** A row of the Deepnote Explorer tree: a project group ("N files") or a notebook leaf ("N cells"). */
export interface DeepnoteTreeRow {
    item: ViewItem;
    label: string;
    description: string;
    /** A project group reads "N files". */
    isGroup: boolean;
    /** A single-notebook leaf reads "N cells". */
    isLeaf: boolean;
}

/** Opens the Deepnote view container and returns its "Explorer" tree section. */
export async function getDeepnoteExplorerSection() {
    const control = await new ActivityBar().getViewControl('Deepnote');
    await control?.openView();
    await VSBrowser.instance.driver.sleep(1200);

    const content = new SideBarView().getContent();
    const named = await content.getSection('Explorer').catch(() => undefined);

    return named ?? (await content.getSections())[0];
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

/** Reads the currently-visible tree rows, classifying each as a project group or a notebook leaf. */
export async function readDeepnoteTreeRows(
    section: Awaited<ReturnType<typeof getDeepnoteExplorerSection>>
): Promise<DeepnoteTreeRow[]> {
    const rows: DeepnoteTreeRow[] = [];

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

/** Finds a project-group tree item by label. */
export async function findDeepnoteGroup(
    section: Awaited<ReturnType<typeof getDeepnoteExplorerSection>>,
    label: string
): Promise<ViewItem | undefined> {
    return (await readDeepnoteTreeRows(section)).find((row) => row.label === label && row.isGroup)?.item;
}

/** Expands the (single) project group, then finds a notebook leaf by name. */
export async function findDeepnoteLeaf(
    section: Awaited<ReturnType<typeof getDeepnoteExplorerSection>>,
    label: string
): Promise<ViewItem | undefined> {
    const group = (await readDeepnoteTreeRows(section)).find((row) => row.isGroup)?.item;
    await (group as unknown as { expand(): Promise<void> } | undefined)?.expand().catch(() => undefined);
    await VSBrowser.instance.driver.sleep(800);

    return (await readDeepnoteTreeRows(section)).find((row) => row.label === label && row.isLeaf)?.item;
}

/**
 * Right-clicks a tree item and invokes a context-menu command by label via raw DOM, avoiding
 * ExTester's ContextMenu model (whose lazy re-query throws for modal-opening commands).
 */
export async function selectDeepnoteContextMenu(item: ViewItem, command: string): Promise<void> {
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
