/**
 * The preview opens in VS Code's integrated browser, an Electron view the driver lists as a window of its own, so the
 * page is read and captured from that window. The extension uses it whenever `workbench.action.browser.open` exists, as
 * it always does in desktop VS Code, so the Simple Browser's webview, which editors without an integrated browser get,
 * is not covered here.
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
    Workbench,
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
const INPUTS_NOTEBOOK_FIXTURE = 'app-preview-inputs.deepnote';
const RUNS_NOTEBOOK_FIXTURES = ['app-preview-runs.deepnote', 'app-preview-runs-init.deepnote'];
const SYNCED_APP = path.join('Sales', '.files', '_deepnote_static');
const SYNCED_TITLE = 'Synced fixture';
const RELOAD_TITLE = 'Reload fixture';
const REUSE_TITLE = 'Reuse fixture';
const INPUTS_TITLE = 'Inputs fixture';
const RUNS_TITLE = 'Runs fixture';
const PREVIEW_URL = /^http:\/\/127\.0\.0\.1:\d+\//;
const NOT_SUPPORTED = 'which the local preview does not support yet.';
const INPUTS_RESOLVED = 'inputs() resolved: ';

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
        'appData() rejected: appData() is not supported in the local preview yet.',
        'appData() again rejected: appData() is not supported in the local preview yet.',
        'requests to deepnote.com: 0'
    ];
}

function withParsedInputs(report: string[]): unknown[] {
    return report.map((line) =>
        line.startsWith(INPUTS_RESOLVED) ? JSON.parse(line.slice(INPUTS_RESOLVED.length)) : line
    );
}

function appDataWarning(folderName: string): string {
    return `The app in ${folderName} called appData(), which the local preview does not support yet.`;
}

async function readReport(): Promise<unknown[]> {
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
            WORKBENCH_TIMEOUT,
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

async function runWithRegion(
    region: string,
    timeout = WORKBENCH_TIMEOUT
): Promise<{ status: string; result: unknown }> {
    const driver = VSBrowser.instance.driver;
    await driver.findElement(By.css(`#region option[value="${region}"]`)).click();
    await driver.findElement(By.id('run')).click();
    let status = '';
    await driver.wait(
        async () => {
            status = await driver.findElement(By.id('status')).getText();

            return status !== 'running';
        },
        timeout,
        `the run with region "${region}" did not finish`
    );
    const result = await driver.findElement(By.id('result')).getText();

    return { status, result: result === '' ? null : JSON.parse(result) };
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

function copyRetitledApp(appDir: string, title: string): void {
    fs.cpSync(FIXTURE_APP, appDir, { recursive: true });
    const index = path.join(appDir, 'index.html');
    fs.writeFileSync(
        index,
        fs.readFileSync(index, 'utf8').replace('<title>Preview fixture</title>', `<title>${title}</title>`)
    );
}

async function waitForEditors(titles: string[], active: string): Promise<void> {
    let seen: string[] = [];
    let seenActive: string | undefined;
    try {
        await VSBrowser.instance.driver.wait(
            async () => {
                const editors = new EditorView();
                seen = await editors.getOpenEditorTitles().catch(() => []);
                seenActive = await (await editors.getActiveTab().catch(() => undefined))?.getTitle().catch(() => '');

                return seenActive === active && JSON.stringify(seen) === JSON.stringify(titles);
            },
            WORKBENCH_TIMEOUT,
            `the editors are not ${JSON.stringify(titles)} with "${active}" active`
        );
    } catch (error) {
        throw new Error(`${(error as Error).message}. Seen: ${JSON.stringify(seen)}, "${seenActive}" active`);
    }
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

    /**
     * Each test, and each attempt Mocha retries, gets a folder no earlier attempt previewed: the extension keeps one
     * preview session per folder while it runs, a session warns about each unsupported operation only once, and two
     * tests edit their page. The page titles tell the integrated browser windows apart.
     */
    function addAppFolder(title: string): string {
        const appDir = fs.mkdtempSync(path.join(workspaceDir, 'app-'));
        copyRetitledApp(appDir, title);

        return appDir;
    }

    before(async function () {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-preview-'));
        fs.mkdirSync(path.join(workspaceDir, '.vscode'));
        fs.writeFileSync(
            path.join(workspaceDir, '.vscode', 'settings.json'),
            JSON.stringify({ 'explorer.compactFolders': false })
        );
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
        if (workspaceDir) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it("opens the folder from the Explorer in the integrated browser, with its assets and the bundled copy of Deepnote's client", async function () {
        const screenshot = createScreenshotter(this);
        const appDir = addAppFolder('Preview fixture');
        await clearNotifications();

        await selectDeepnoteContextMenu(await findRootExplorerItem(path.basename(appDir)), 'Preview App');

        const report = await onIntegratedBrowserPage('Preview fixture', async () => {
            const read = await readReport();
            await screenshot('integrated-browser-page');

            return read;
        });
        expect(report).to.deep.equal(expectedReport('Sales dashboard'));
        expect(await new EditorView().getOpenEditorTitles()).to.deep.equal(['Preview fixture']);

        expect(await previewWarnings(1)).to.deep.equal([appDataWarning(path.basename(appDir))]);
        await screenshot('app-data-warning');
    });

    it('shows an edit after a reload, and does not warn again', async function () {
        const screenshot = createScreenshotter(this);
        const appDir = addAppFolder(RELOAD_TITLE);
        await clearNotifications();
        await selectDeepnoteContextMenu(await findRootExplorerItem(path.basename(appDir)), 'Preview App');
        await onIntegratedBrowserPage(RELOAD_TITLE, readReport);
        await previewWarnings(1);
        await clearNotifications();

        const indexFile = path.join(appDir, 'index.html');
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
        const appDir = addAppFolder(INPUTS_TITLE);
        await selectDeepnoteContextMenu(await findRootExplorerItem(path.basename(appDir)), 'Preview App');

        const report = await onIntegratedBrowserPage(INPUTS_TITLE, async () => {
            const read = await readReport();
            await screenshot('rendered-inputs');

            return read;
        });
        expect(report).to.deep.include(NOTEBOOK_INPUTS);

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

    it("runs the workspace notebook with each run's inputs, after its init notebook, and reports its result or its error", async function () {
        const screenshot = createScreenshotter(this);
        await clearNotifications();
        const appDir = fs.mkdtempSync(path.join(workspaceDir, 'runs-app-'));
        fs.cpSync(RUNS_FIXTURE_APP, appDir, { recursive: true });

        await selectDeepnoteContextMenu(await findRootExplorerItem(path.basename(appDir)), 'Preview App');

        // The first run starts the notebook file's toolkit server and a kernel.
        const runs = await onIntegratedBrowserPage(RUNS_TITLE, async () => {
            const asia = await runWithRegion('Asia', KERNEL_CONNECT_TIMEOUT);
            const americas = await runWithRegion('Americas');
            const noRegion = await runWithRegion('');
            await screenshot('run-results');

            return [asia, americas, noRegion];
        });
        expect(runs).to.deep.equal([
            { status: 'success', result: { region: 'Asia', init_region: false } },
            { status: 'success', result: { region: 'Americas', init_region: false } },
            // The notebook displays its result before the block that raises, in Deepnote's block order.
            { status: 'error, ValueError: Choose a region first', result: { region: '', init_region: false } }
        ]);

        const center = await new Workbench().openNotificationsCenter();
        const messages = await Promise.all(
            (await center.getNotifications(NotificationType.Warning)).map((notification) => notification.getMessage())
        );
        expect(messages.filter((message) => message.endsWith(NOT_SUPPORTED))).to.deep.equal([]);
        await screenshot('no-run-warning');
        await center.close();
    });

    it('switches to the open tab and reloads it when the same folder is previewed again', async function () {
        const screenshot = createScreenshotter(this);
        const driver = VSBrowser.instance.driver;
        const appDir = addAppFolder(REUSE_TITLE);
        const preview = async () =>
            selectDeepnoteContextMenu(await findRootExplorerItem(path.basename(appDir)), 'Preview App');
        await preview();
        await onIntegratedBrowserPage(REUSE_TITLE, readReport);
        await new Workbench().executeCommand('File: New Untitled Text File');
        await waitForEditors([REUSE_TITLE, 'Untitled-1'], 'Untitled-1');
        const indexFile = path.join(appDir, 'index.html');
        fs.writeFileSync(
            indexFile,
            fs.readFileSync(indexFile, 'utf8').replace('Sales dashboard', 'Sales dashboard, edited')
        );

        await preview();

        await waitForEditors([REUSE_TITLE, 'Untitled-1'], REUSE_TITLE);
        await onIntegratedBrowserPage(REUSE_TITLE, () =>
            driver.wait(
                async () =>
                    (await driver
                        .executeScript<string>("return document.querySelector('h1')?.textContent")
                        .catch(() => '')) === 'Sales dashboard, edited',
                WORKBENCH_TIMEOUT,
                'the reused tab did not reload'
            )
        );
        await screenshot('reused-tab');
    });

    it('previews a folder chosen from the Command Palette, inside a dot-named .files folder', async function () {
        const screenshot = createScreenshotter(this);
        const syncedDir = fs.mkdtempSync(path.join(workspaceDir, 'synced-'));
        copyRetitledApp(path.join(syncedDir, SYNCED_APP), SYNCED_TITLE);
        await clearNotifications();

        await previewFromCommandPalette(path.join(syncedDir, SYNCED_APP));

        const report = await onIntegratedBrowserPage(SYNCED_TITLE, async () => {
            const read = await readReport();
            await screenshot('synced-app-page');

            return read;
        });

        expect(report).to.deep.equal(expectedReport('Sales dashboard'));
        expect(await previewWarnings(1)).to.deep.equal([appDataWarning('_deepnote_static')]);
        await screenshot('synced-app-warnings');
    });
});
