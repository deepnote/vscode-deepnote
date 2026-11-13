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
    NotificationType,
    SideBarView,
    VSBrowser,
    WebView,
    Workbench,
    until,
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
const INPUTS_NOTEBOOK_FIXTURE = 'app-preview-inputs.deepnote';
const RUNS_NOTEBOOK_FIXTURES = ['app-preview-runs.deepnote', 'app-preview-runs-init.deepnote'];
const PROJECT_FIXTURE = 'hello-world.deepnote';
const RELOAD_APP = 'reload-app';
const RELOAD_TITLE = 'Reload fixture';
const INPUTS_APP = 'inputs-app';
const INPUTS_TITLE = 'Inputs fixture';
const RUNS_TITLE = 'Runs fixture';
const APP_DATA_TITLE = 'App data fixture';
const PREVIEW_URL = /^http:\/\/127\.0\.0\.1:\d+\//;
const NOT_SUPPORTED = 'which the local preview does not support yet.';
const INPUTS_RESOLVED = 'inputs() resolved: ';
const RUN_RESULT = ' result(): ';
const APP_DATA_AFTER_RUN = 'appData() after the run: ';

const NO_RUN_RESULTS = 'You have no run results for this notebook yet. Run the notebook to load them.';
const DATAFRAME_NOT_SUPPORTED = 'dataframe() is not supported in the local preview yet.';
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

function expectedReport(title: string): unknown[] {
    return [
        title,
        'client: function',
        'styles: rgb(0, 128, 0)',
        'logo: 48x48',
        NOTEBOOK_INPUTS,
        'inputs() of an unknown notebook rejected: Notebook not found',
        `appData() rejected: ${NO_RUN_RESULTS}`,
        `dataframe() rejected: ${DATAFRAME_NOT_SUPPORTED}`,
        `dataframe() again rejected: ${DATAFRAME_NOT_SUPPORTED}`,
        'requests to deepnote.com: 0'
    ];
}

function withParsedInputs(report: string[]): unknown[] {
    return report.map((line) =>
        line.startsWith(INPUTS_RESOLVED) ? JSON.parse(line.slice(INPUTS_RESOLVED.length)) : line
    );
}

function dataframeWarning(folderName: string): string {
    return `The app in ${folderName} called dataframe(), which the local preview does not support yet.`;
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

/** Leaves the Notifications Center open, so the next screenshot shows the warnings. */
async function previewWarnings(count: number): Promise<string[]> {
    const center = await new Workbench().openNotificationsCenter();
    let warnings: string[] = [];
    try {
        await VSBrowser.instance.driver.wait(
            async () => {
                const notifications = await center.getNotifications(NotificationType.Warning).catch(() => []);
                const messages = await Promise.all(notifications.map((n) => n.getMessage().catch(() => '')));
                warnings = messages.filter((message) => message.endsWith(NOT_SUPPORTED));

                return warnings.length >= count;
            },
            WORKBENCH_TIMEOUT,
            `fewer than ${count} preview warnings arrived`
        );
    } catch (error) {
        await center.close().catch(() => undefined);
        throw new Error(`${(error as Error).message}. Seen: ${JSON.stringify(warnings)}`);
    }

    return warnings;
}

async function clearNotifications(): Promise<void> {
    const center = await new Workbench().openNotificationsCenter();
    await center.clearAllNotifications();
    await center.close().catch(() => undefined);
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

    // A preview session warns once per operation for the extension's lifetime, so a retry previewing the same folder
    // would wait for a warning that never comes. Each attempt gets its own folder, and so its own session. The folder
    // holds a project, or dataframe() would reject in the page without reaching the preview.
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
        await clearNotifications();

        const folder = freshApp('app', 'Preview fixture');
        await selectDeepnoteContextMenu(await findRootExplorerItem(folder), 'Preview App');

        const report = await onIntegratedBrowserPage('Preview fixture', async () => {
            const read = await readReport();
            await screenshot('integrated-browser-page');

            return read;
        });
        expect(report).to.deep.equal(expectedReport('Sales dashboard'));
        expect(await new EditorView().getOpenEditorTitles()).to.deep.equal(['Preview fixture']);

        // inputs() and appData() are answered, and the page called dataframe() twice, so one warning names dataframe().
        expect(await previewWarnings(1)).to.deep.equal([dataframeWarning(folder)]);
        await screenshot('dataframe-warning');
    });

    it('shows an edit after a reload, and does not warn again', async function () {
        const screenshot = createScreenshotter(this);
        await clearNotifications();
        const folder = freshApp(RELOAD_APP, RELOAD_TITLE);
        await selectDeepnoteContextMenu(await findRootExplorerItem(folder), 'Preview App');
        await onIntegratedBrowserPage(RELOAD_TITLE, readReport);
        await previewWarnings(1);
        await clearNotifications();

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
        const center = await new Workbench().openNotificationsCenter();
        const warnings = await center.getNotifications(NotificationType.Warning);
        expect(warnings).to.have.length(0);
        await center.close();
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
        // No .deepnote file is in or above inputs-app, so dataframe() rejects in the page without a request.
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
        await clearNotifications();
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

        const center = await new Workbench().openNotificationsCenter();
        const messages = await Promise.all(
            (await center.getNotifications(NotificationType.Warning)).map((notification) => notification.getMessage())
        );
        expect(messages.filter((message) => message.endsWith(NOT_SUPPORTED))).to.deep.equal([]);
        await screenshot('no-run-warning');
        await center.close();
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

    it('renders a synced app in the Simple Browser, with the project of the .deepnote file next to its .files folder', async function () {
        const screenshot = createScreenshotter(this);
        await setIntegratedBrowser(false);
        await clearNotifications();

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
        expect(await previewWarnings(1)).to.deep.equal([dataframeWarning('_deepnote_static')]);
        await screenshot('synced-app-warnings');
    });
});
