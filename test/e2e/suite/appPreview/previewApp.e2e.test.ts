/**
 * VS Code 1.111 opens `simpleBrowser.api.open` in its integrated browser, an Electron view the driver lists as a window
 * of its own, so the page is read and captured from that window. With `simpleBrowser.useIntegratedBrowser` off, the
 * Simple Browser shows the page in a frame inside a webview, which the workbench screenshot includes.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    By,
    EditorView,
    InputBox,
    SideBarView,
    VSBrowser,
    WebView,
    Workbench,
    until,
    type TreeItem,
    type ViewItem
} from 'vscode-extension-tester';

import {
    KERNEL_CONNECT_TIMEOUT,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickDialogOkButton,
    copyFixtureIntoDir,
    createScreenshotter,
    openActivityBarView,
    openFolderViaDialog,
    selectDeepnoteContextMenu
} from '../../helpers';

const FIXTURE_APP = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', 'app-preview');
const RUNS_FIXTURE_APP = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', 'app-preview-runs');
const APP_DATA_FIXTURE_APP = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', 'app-preview-app-data');
const DATAFRAMES_FIXTURE = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', 'app-preview-dataframes');
const INPUTS_NOTEBOOK_FIXTURE = 'app-preview-inputs.deepnote';
const RUNS_NOTEBOOK_FIXTURES = ['app-preview-runs.deepnote', 'app-preview-runs-init.deepnote'];
const PROJECT_FIXTURE = 'hello-world.deepnote';
const RELOAD_APP = 'reload-app';
const RELOAD_TITLE = 'Reload fixture';
const INPUTS_APP = 'inputs-app';
const INPUTS_TITLE = 'Inputs fixture';
const RUNS_TITLE = 'Runs fixture';
const APP_DATA_TITLE = 'App data fixture';
const DATAFRAMES_APP = 'app';
const DATAFRAMES_TITLE = 'Customers';
const PREVIEW_URL = /^http:\/\/127\.0\.0\.1:\d+\//;
const INPUTS_RESOLVED = 'inputs() resolved: ';
const RUN_RESULT = ' result(): ';
const APP_DATA_AFTER_RUN = 'appData() after the run: ';

const NO_RUN_RESULTS = 'You have no run results for this notebook yet. Run the notebook to load them.';
const DATAFRAME_NOT_FOUND = 'Dataframe not found';
const NO_PROJECT_DATAFRAME =
    "This app folder is not next to or inside the folder of a Deepnote project's .deepnote files, so it has no stored dataframes. After adding one, run Deepnote: Preview App again.";

const NOTEBOOK_INPUTS = [
    { blockId: 'e2e-region-input', name: 'region', type: 'input-text', value: 'Europe', label: 'Region' },
    {
        blockId: 'e2e-threshold-input',
        name: 'threshold',
        type: 'input-slider',
        value: '40',
        label: 'Threshold',
        min: 10,
        max: 90,
        step: 5
    },
    {
        blockId: 'e2e-products-input',
        name: 'products',
        type: 'input-select',
        value: ['Chairs', 'Lamps'],
        label: 'Products',
        options: ['Chairs', 'Desks', 'Lamps'],
        multiple: true
    }
];

const FRAME_NAME = 'customers';
const FRAME_FILE = '3f2b8c1e-6d4a-4e9b-9a7c-0d5e1f2a3b4c.arrow';
const FIRST_ROW = [
    '0',
    'customer-000039',
    '58.88',
    'silver',
    'false',
    '2025-01-01T00:00:04.000',
    'left voicemail (ticket 34)'
];
const LAST_ROW = [
    '199999',
    'customer-000167',
    '68.8',
    'diamond',
    'true',
    '2025-01-06T19:13:25.000',
    'called back (ticket 33)'
];

interface DataframeSitePage {
    error: string;
    indicator: string;
    isNextDisabled: boolean;
    rows: string[][];
    summary: string;
}

function expectedReport(title: string): unknown[] {
    return [
        title,
        'client: function',
        'styles: rgb(0, 128, 0)',
        'logo: 48x48',
        NOTEBOOK_INPUTS,
        'inputs() of an unknown notebook rejected: Notebook not found',
        `appData() rejected: ${NO_RUN_RESULTS}`,
        `dataframe() rejected: ${DATAFRAME_NOT_FOUND}`,
        `dataframe() again rejected: ${DATAFRAME_NOT_FOUND}`,
        'requests to deepnote.com: 0'
    ];
}

function withParsedInputs(report: string[]): unknown[] {
    return report.map((line) =>
        line.startsWith(INPUTS_RESOLVED) ? JSON.parse(line.slice(INPUTS_RESOLVED.length)) : line
    );
}

async function readReport(timeout = WORKBENCH_TIMEOUT): Promise<unknown[]> {
    const driver = VSBrowser.instance.driver;
    let report: string[] = [];
    try {
        await driver.wait(
            async () => {
                report = await driver
                    .executeScript<string[]>(
                        "return Array.from(document.querySelectorAll('h1, li'), (element) => element.textContent)"
                    )
                    .catch(() => []);

                return report.length > 0 && report.every((line) => !line.endsWith('pending'));
            },
            timeout,
            'the preview page did not finish its client calls'
        );
    } catch (error) {
        throw new Error(`${(error as Error).message}. Last read: ${JSON.stringify(report)}`);
    }

    return withParsedInputs(report);
}

function consecutiveIds(first: number, count: number): string[] {
    return Array.from({ length: count }, (_, offset) => String(first + offset));
}

async function readDataframePage(indicator: string): Promise<DataframeSitePage> {
    const driver = VSBrowser.instance.driver;
    let page: DataframeSitePage | undefined;
    try {
        await driver.wait(
            async () => {
                page = await driver
                    .executeScript<DataframeSitePage>(
                        `return {
                            error: document.querySelector('[role="alert"]').textContent,
                            indicator: document.querySelector('[role="status"]').textContent,
                            isNextDisabled: document.getElementById('next').disabled,
                            rows: Array.from(document.querySelectorAll('tbody tr'), (row) =>
                                Array.from(row.cells, (cell) => cell.textContent)
                            ),
                            summary: document.getElementById('summary').textContent
                        };`
                    )
                    .catch(() => undefined);

                return page?.indicator === indicator;
            },
            WORKBENCH_TIMEOUT,
            `the dataframe site did not show "${indicator}"`
        );
    } catch (error) {
        throw new Error(`${(error as Error).message}. Last read: ${JSON.stringify(page)}`);
    }

    return page!;
}

async function onIntegratedBrowserPage<T>(title: string, read: () => Promise<T>): Promise<T> {
    const driver = VSBrowser.instance.driver;
    const workbench = await driver.getWindowHandle();
    try {
        await driver.wait(
            async () => {
                for (const handle of await driver.getAllWindowHandles()) {
                    if (handle === workbench) {
                        continue;
                    }
                    await driver.switchTo().window(handle);
                    const url = await driver.getCurrentUrl().catch(() => '');
                    if (PREVIEW_URL.test(url) && (await driver.getTitle().catch(() => '')) === title) {
                        return true;
                    }
                }
                await driver.switchTo().window(workbench);

                return false;
            },
            WORKBENCH_TIMEOUT,
            `the integrated browser did not open the page "${title}"`
        );

        return await read();
    } finally {
        await driver.switchTo().window(workbench);
    }
}

async function onSimpleBrowserPage<T>(read: () => Promise<T>): Promise<T> {
    const driver = VSBrowser.instance.driver;
    const webView = new WebView();
    await webView.switchToFrame(WORKBENCH_TIMEOUT);
    try {
        await driver.switchTo().frame(await driver.wait(until.elementLocated(By.css('iframe')), WORKBENCH_TIMEOUT));

        return await read();
    } finally {
        await webView.switchBack();
    }
}

async function findRootExplorerItem(label: string): Promise<ViewItem> {
    await openActivityBarView('Explorer');
    let found: ViewItem | undefined;
    await VSBrowser.instance.driver.wait(
        async () => {
            const [section] = await new SideBarView().getContent().getSections();
            found = await section?.findItem(label).catch(() => undefined);

            return found !== undefined;
        },
        WORKBENCH_TIMEOUT,
        `"${label}" did not appear in the file explorer`
    );

    return found!;
}

/** Looks the parent up again on every try, so a row the Explorer has re-rendered is not held stale. */
async function findExplorerChildItem(parentLabel: string, label: string): Promise<TreeItem> {
    let found: TreeItem | undefined;
    await VSBrowser.instance.driver.wait(
        async () => {
            const parent = (await findRootExplorerItem(parentLabel)) as TreeItem;
            found = await parent.findChildItem(label).catch(() => undefined);

            return found !== undefined;
        },
        WORKBENCH_TIMEOUT,
        `"${label}" did not appear under "${parentLabel}" in the file explorer`
    );

    return found!;
}

/** In the simple folder dialog, OK first navigates toward the typed path, so it is clicked until the dialog closes. */
async function previewFromCommandPalette(folder: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await new Workbench().executeCommand('Deepnote: Preview App');
    const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
    await dialog.setText(folder);
    await driver.wait(
        async () => (await dialog.getQuickPicks().catch(() => [])).length > 0,
        QUICK_PICK_TIMEOUT,
        'the folder dialog did not list the typed folder'
    );
    await driver.wait(
        async () => {
            if (!(await dialog.isDisplayed().catch(() => false))) {
                return true;
            }
            await clickDialogOkButton('Preview');

            return false;
        },
        QUICK_PICK_TIMEOUT,
        `the folder dialog did not accept ${folder}`
    );
}

async function setIntegratedBrowser(enabled: boolean): Promise<void> {
    const settings = await new Workbench().openSettings();
    await (await settings.findSettingByID('simpleBrowser.useIntegratedBrowser')).setValue(enabled);
    await closeAllEditors();
}

/** EditorView.closeAllEditors cannot find the close button of the integrated browser's tab. */
async function closeAllEditors(): Promise<void> {
    await new Workbench().executeCommand('View: Close All Editors');
    await VSBrowser.instance.driver.wait(
        async () => (await new EditorView().getOpenEditorTitles().catch(() => ['?'])).length === 0,
        WORKBENCH_TIMEOUT,
        'the editors did not close'
    );
}

describe('Deepnote: Preview App — serve a data app folder in the built-in browser', function () {
    this.timeout(SUITE_TIMEOUT);

    let workspaceDir = '';
    let inputsNotebookFile = '';
    let attempt = 0;

    function copyAppWithTitle(folder: string, title: string): void {
        fs.cpSync(FIXTURE_APP, path.join(workspaceDir, folder), { recursive: true });
        const index = path.join(workspaceDir, folder, 'index.html');
        fs.writeFileSync(
            index,
            fs.readFileSync(index, 'utf8').replace('<title>Preview fixture</title>', `<title>${title}</title>`)
        );
    }

    // The folder holds a project, or dataframe() would reject in the page without reaching the preview.
    function freshApp(base: string, title: string): string {
        const folder = `${base}-${attempt++}`;
        copyAppWithTitle(folder, title);
        copyFixtureIntoDir(path.join(workspaceDir, folder), PROJECT_FIXTURE);

        return folder;
    }

    /** A synced project of its own with the app in its `.files/_deepnote_static`; returns the app folder's path. */
    function freshSyncedApp(): string {
        const project = path.join(workspaceDir, `synced-${attempt++}`, 'Sales');
        const app = path.join(project, '.files', '_deepnote_static');
        fs.cpSync(FIXTURE_APP, app, { recursive: true });
        copyFixtureIntoDir(project, PROJECT_FIXTURE);

        return app;
    }

    function freshDataframesProject(): string {
        const folder = `dataframes-${attempt++}`;
        const project = path.join(workspaceDir, folder);
        // Laid out as deepnote-toolkit's `store_dataframe` writes a frame, extra manifest keys included.
        const frameDir = path.join(project, 'deepnote_dataframes', FRAME_NAME);
        fs.mkdirSync(frameDir, { recursive: true });
        fs.copyFileSync(path.join(DATAFRAMES_FIXTURE, FRAME_FILE), path.join(frameDir, FRAME_FILE));
        fs.writeFileSync(
            path.join(frameDir, 'manifest.json'),
            JSON.stringify({
                version: 1,
                file: FRAME_FILE,
                previous: null,
                written_at: '2026-09-25T09:14:03Z',
                rows: 200_000,
                batch_rows: [65_536, 65_536, 65_536, 3_392],
                toolkit_version: '2.9.0'
            })
        );
        fs.mkdirSync(path.join(project, DATAFRAMES_APP));
        fs.copyFileSync(path.join(DATAFRAMES_FIXTURE, 'index.html'), path.join(project, DATAFRAMES_APP, 'index.html'));
        copyFixtureIntoDir(project, PROJECT_FIXTURE);

        return folder;
    }

    before(async function () {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-preview-'));
        fs.mkdirSync(path.join(workspaceDir, '.vscode'));
        fs.writeFileSync(
            path.join(workspaceDir, '.vscode', 'settings.json'),
            JSON.stringify({ 'explorer.compactFolders': false })
        );
        copyAppWithTitle(INPUTS_APP, INPUTS_TITLE);
        // Kept out of every app folder and the folders above them, so no app resolves to this project.
        fs.mkdirSync(path.join(workspaceDir, 'notebooks'));
        inputsNotebookFile = copyFixtureIntoDir(path.join(workspaceDir, 'notebooks'), INPUTS_NOTEBOOK_FIXTURE);
        RUNS_NOTEBOOK_FIXTURES.forEach((fixture) => copyFixtureIntoDir(path.join(workspaceDir, 'notebooks'), fixture));

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(workspaceDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
    });

    afterEach(async function () {
        await new InputBox().cancel().catch(() => undefined);
        await closeAllEditors().catch((error) => console.warn('[deepnote-e2e] close editors:', error));
    });

    after(async function () {
        await setIntegratedBrowser(true).catch((error) => console.warn('[deepnote-e2e] restore browser:', error));
        if (workspaceDir) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it('opens the folder from the Explorer in the integrated browser, with its assets and the extension client', async function () {
        const screenshot = createScreenshotter(this);

        const folder = freshApp('app', 'Preview fixture');
        await selectDeepnoteContextMenu(await findRootExplorerItem(folder), 'Preview App');

        const report = await onIntegratedBrowserPage('Preview fixture', async () => {
            const read = await readReport();
            await screenshot('integrated-browser-page');

            return read;
        });
        expect(report).to.deep.equal(expectedReport('Sales dashboard'));
        expect(await new EditorView().getOpenEditorTitles()).to.deep.equal(['Preview fixture']);
    });

    it('shows an edit after a reload', async function () {
        const screenshot = createScreenshotter(this);
        const folder = freshApp(RELOAD_APP, RELOAD_TITLE);
        await selectDeepnoteContextMenu(await findRootExplorerItem(folder), 'Preview App');
        await onIntegratedBrowserPage(RELOAD_TITLE, readReport);

        const indexFile = path.join(workspaceDir, folder, 'index.html');
        fs.writeFileSync(
            indexFile,
            fs.readFileSync(indexFile, 'utf8').replace('Sales dashboard', 'Sales dashboard, edited')
        );
        const report = await onIntegratedBrowserPage(RELOAD_TITLE, async () => {
            await VSBrowser.instance.driver.navigate().refresh();
            const read = await readReport();
            await screenshot('reloaded-page');

            return read;
        });

        expect(report).to.deep.equal(expectedReport('Sales dashboard, edited'));
    });

    it('answers inputs() from the .deepnote file as saved on disk, after an edit and a reload', async function () {
        const screenshot = createScreenshotter(this);
        await selectDeepnoteContextMenu(await findRootExplorerItem(INPUTS_APP), 'Preview App');

        const report = await onIntegratedBrowserPage(INPUTS_TITLE, async () => {
            const read = await readReport();
            await screenshot('rendered-inputs');

            return read;
        });
        expect(report).to.deep.include(NOTEBOOK_INPUTS);
        expect(report).to.include.members([
            `dataframe() rejected: ${NO_PROJECT_DATAFRAME}`,
            `dataframe() again rejected: ${NO_PROJECT_DATAFRAME}`
        ]);

        const original = fs.readFileSync(inputsNotebookFile, 'utf8');
        try {
            fs.writeFileSync(
                inputsNotebookFile,
                original
                    .replace('deepnote_variable_value: Europe', 'deepnote_variable_value: Asia')
                    .replace('deepnote_slider_max_value: 90', 'deepnote_slider_max_value: 120')
            );
            const edited = await onIntegratedBrowserPage(INPUTS_TITLE, async () => {
                await VSBrowser.instance.driver.navigate().refresh();
                const read = await readReport();
                await screenshot('edited-inputs');

                return read;
            });

            const [region, threshold, products] = NOTEBOOK_INPUTS;
            expect(edited).to.deep.include([{ ...region, value: 'Asia' }, { ...threshold, max: 120 }, products]);
        } finally {
            fs.writeFileSync(inputsNotebookFile, original);
        }
    });

    it('runs the workspace notebook for run(), after its init notebook, and reports its result or its error', async function () {
        const screenshot = createScreenshotter(this);
        const folder = `runs-app-${attempt++}`;
        fs.cpSync(RUNS_FIXTURE_APP, path.join(workspaceDir, folder), { recursive: true });

        await selectDeepnoteContextMenu(await findRootExplorerItem(folder), 'Preview App');

        // The first run starts the notebook file's toolkit server and a kernel.
        const report = await onIntegratedBrowserPage(RUNS_TITLE, async () => {
            const read = await readReport(KERNEL_CONNECT_TIMEOUT);
            await screenshot('run-results');

            return read;
        });
        expect(
            report.map((line) => {
                const text = String(line);
                const at = text.indexOf(RUN_RESULT);

                return at === -1 ? text : [text.slice(0, at), JSON.parse(text.slice(at + RUN_RESULT.length))];
            })
        ).to.deep.equal([
            'Sales runs',
            'run({ unknown: \'x\' }) rejected: Input "unknown" is not defined for this notebook',
            "run({ region: 'Asia' }): success",
            ["run({ region: 'Asia' })", { region: 'Asia', init_region: false }],
            "run({ region: '' }): error, ValueError: Choose a region first",
            // The notebook displays its result before the block that raises, in Deepnote's block order.
            ["run({ region: '' })", { region: '', init_region: false }]
        ]);
    });

    it("answers appData() from the notebook's newest successful run: none before a run, then its JSON output", async function () {
        const screenshot = createScreenshotter(this);
        const folder = `app-data-app-${attempt++}`;
        fs.cpSync(APP_DATA_FIXTURE_APP, path.join(workspaceDir, folder), { recursive: true });
        const startedAt = Date.now();

        await selectDeepnoteContextMenu(await findRootExplorerItem(folder), 'Preview App');

        const report = await onIntegratedBrowserPage(APP_DATA_TITLE, async () => {
            const read = await readReport(KERNEL_CONNECT_TIMEOUT);
            await screenshot('app-data-after-run');

            return read;
        });
        const lines = report.map((line) => {
            const text = String(line);

            return text.startsWith(APP_DATA_AFTER_RUN) ? JSON.parse(text.slice(APP_DATA_AFTER_RUN.length)) : text;
        });
        const createdAt = /, created at (\S+)$/.exec(String(lines[2]))?.[1];
        expect(lines).to.deep.equal([
            'Sales results',
            `appData() before a run rejected: ${NO_RUN_RESULTS}`,
            `run({ region: 'Asia' }): success, created at ${createdAt}`,
            { appData: { region: 'Asia', init_region: false }, agentBlockSummary: null, runCreatedAt: createdAt }
        ]);
        expect(Date.parse(createdAt ?? ''), `the run's createdAt, ${createdAt}`).to.be.within(startedAt, Date.now());
    });

    it("pages through a dataframe stored in the app's project folder, across its record batches", async function () {
        const screenshot = createScreenshotter(this);
        const folder = freshDataframesProject();
        await selectDeepnoteContextMenu(await findExplorerChildItem(folder, DATAFRAMES_APP), 'Preview App');

        await onIntegratedBrowserPage(DATAFRAMES_TITLE, async () => {
            const driver = VSBrowser.instance.driver;
            const clickButton = (name: string) =>
                driver.findElement(By.xpath(`//button[normalize-space()='${name}']`)).click();
            const ids = (page: DataframeSitePage) => page.rows.map(([id]) => id);

            const first = await readDataframePage('Page 1 of 20,000');
            expect(first.summary).to.include('200,000 rows · 7 columns');
            expect(first.rows[0]).to.deep.equal(FIRST_ROW);
            expect(ids(first)).to.deep.equal(consecutiveIds(0, 10));
            await screenshot('first-page');

            await clickButton('Next');
            expect(ids(await readDataframePage('Page 2 of 20,000'))).to.deep.equal(consecutiveIds(10, 10));
            await screenshot('next-page');

            // Rows 65,530 to 65,539 straddle the end of the first record batch, at row 65,536.
            const pageNumber = driver.findElement(By.css('input[type="number"]'));
            await pageNumber.clear();
            await pageNumber.sendKeys('6554');
            await clickButton('Go');
            expect(ids(await readDataframePage('Page 6,554 of 20,000'))).to.deep.equal(consecutiveIds(65_530, 10));
            await screenshot('across-record-batches');

            await clickButton('Last');
            const last = await readDataframePage('Page 20,000 of 20,000');
            expect(last.rows.at(-1)).to.deep.equal(LAST_ROW);
            expect(last.isNextDisabled).to.equal(true);
            await screenshot('last-page');
        });
    });

    it('renders a synced app in the Simple Browser, with the project of the .deepnote file next to its .files folder', async function () {
        const screenshot = createScreenshotter(this);
        await setIntegratedBrowser(false);

        await previewFromCommandPalette(freshSyncedApp());

        await VSBrowser.instance.driver.wait(
            async () =>
                (await new EditorView().getOpenEditorTitles().catch((): string[] => [])).includes('Simple Browser'),
            WORKBENCH_TIMEOUT,
            'the Simple Browser did not open'
        );
        const report = await onSimpleBrowserPage(readReport);
        await screenshot('simple-browser-synced-app');

        expect(report).to.deep.equal(expectedReport('Sales dashboard'));
    });
});
