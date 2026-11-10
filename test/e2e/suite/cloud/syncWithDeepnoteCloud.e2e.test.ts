import { MOCK_WORKSPACE_NAME, startMockDeepnoteCloud, type MockDeepnoteCloud } from '@deepnote/cloud-mock';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { By, EditorView, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    API_TOKEN,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickDialogOkButton,
    confirmModalDialog,
    copyFixtureIntoDir,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    setApiToken,
    waitForNotification
} from '../../helpers';

const SYNC = 'Deepnote: Sync with Deepnote Cloud';
const SYNC_NEW_FOLDER = 'Deepnote: Sync a New Folder with Deepnote Cloud…';

const ANALYTICS = { id: '8b3e1f6a-2c4d-4e5f-9a7b-1c3d5e7f9a2b', name: 'Analytics' };
const REVENUE = 'cloud-sync-analytics-revenue.deepnote';
const COSTS = 'cloud-sync-analytics-costs.deepnote';
const FORECAST = 'cloud-sync-analytics-forecast.deepnote';
const REVENUE_TEXT = 'revenue from Deepnote';

const MAIN = { id: '4f0c2a8e-6b1d-4c3e-9a7f-2d5e8b1c0a93', name: 'E2E Cloud Sync' };
const MAIN_NOTEBOOK = 'cloud-sync.deepnote';
const MAIN_TEXT = 'synced from Deepnote';

const UNTRACKED = 'hello-world.deepnote';
const NOTES_FILE = 'beta-notes.txt';
const LOCAL_EDIT = 'edited locally';
const CLOUD_EDIT = 'edited in Deepnote';
const WORKING_FILE = 'data.csv';
const WORKING_FILE_CONTENT = 'month,revenue\n2025-01,100\n';

const BOTH_SIDES_CHANGED = `"${ANALYTICS.name}" changed both locally and in Deepnote`;
const SYNC_OUTCOME = /^(Sync finished|Sync with Deepnote Cloud failed)/;
const LEFTOVER_SYNC_TIMEOUT = 30_000;

// Asserts that the sync asks nothing: an unanswered prompt, such as the folder pick, keeps the summary from appearing.
const NO_PROMPTS = async (): Promise<void> => undefined;

async function sync(command: string, answerPrompts: () => Promise<void>): Promise<string> {
    await dismissAllNotifications();
    await new Workbench().executeCommand(command);
    await answerPrompts();

    const outcome = await waitForNotification(SYNC_OUTCOME, WORKBENCH_TIMEOUT, true);
    const message = (await outcome?.getMessage()) ?? '';
    if (!message.startsWith('Sync finished')) {
        throw new Error(message);
    }

    return message;
}

async function clearApiToken(): Promise<void> {
    await dismissAllNotifications();
    await new Workbench().executeCommand('Deepnote: Clear API Token');
    await waitForNotification(
        /^(Deepnote API token removed|No Deepnote API token is saved)\.$/,
        WORKBENCH_TIMEOUT,
        true
    );
}

async function hasSyncEnded(): Promise<boolean> {
    const notifications = await new Workbench().getNotifications().catch(() => []);
    const messages = await Promise.all(notifications.map((notification) => notification.getMessage().catch(() => '')));

    return messages.some((message) => SYNC_OUTCOME.test(message));
}

/**
 * Closes the prompts a failed test can leave open until the sync behind them ends. Until then that sync holds the
 * one-at-a-time guard, a modal blocks the command palette, and the sync can still write into folders that the next
 * test creates.
 */
async function closeLeftoverPrompts(): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await driver
        .wait(async () => {
            // A key press goes to whatever has focus, which need not be the dialog, so click its close button.
            // Sync asks about one conflict at a time, so closing one dialog can open the next.
            for (const close of await driver.findElements(By.css('.monaco-dialog-box .codicon-dialog-close'))) {
                await driver
                    .actions()
                    .move({ origin: close })
                    .click()
                    .perform()
                    .catch(() => undefined);
            }
            await new InputBox().cancel().catch(() => undefined);

            return hasSyncEnded();
        }, LEFTOVER_SYNC_TIMEOUT)
        .catch((error) => {
            console.warn('[cloud-sync] a sync left behind by a failed test did not end:', error);
        });
}

async function chooseFolderInDialog(folder: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
    await driver.wait(
        async () => (await dialog.getTitle()) === 'Choose a folder for your Deepnote workspace',
        QUICK_PICK_TIMEOUT,
        'the sync folder dialog did not open'
    );
    await dialog.setText(folder);
    await driver.wait(
        async () => (await dialog.getQuickPicks()).length > 0,
        QUICK_PICK_TIMEOUT,
        `the folder dialog did not list ${folder}`
    );

    // As in openFolderViaDialog, a click can navigate one level toward the typed path instead of
    // accepting it, so click until the dialog closes.
    await driver.wait(
        async () => !(await clickDialogOkButton('Sync Here')),
        QUICK_PICK_TIMEOUT,
        `the folder dialog did not accept ${folder}`
    );
}

function syncNewFolder(folder: string): Promise<string> {
    return sync(SYNC_NEW_FOLDER, async () => {
        await chooseFolderInDialog(folder);
        await confirmModalDialog('Download Projects', { messageIncludes: `into ${path.basename(folder)}?` });
    });
}

async function readFolderPick(): Promise<string[]> {
    const driver = VSBrowser.instance.driver;
    const picker = await InputBox.create(QUICK_PICK_TIMEOUT);
    await driver.wait(
        async () => (await picker.getPlaceHolder()) === 'Choose the folder to sync with Deepnote Cloud',
        QUICK_PICK_TIMEOUT,
        'the synced folder pick did not open'
    );

    return Promise.all((await picker.getQuickPicks()).map((item) => item.getLabel()));
}

function replaceInFile(file: string, from: string, to: string): void {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes(from)) {
        throw new Error(`"${from}" is not in ${file}`);
    }

    fs.writeFileSync(file, content.replace(from, to));
}

function readNotebookFiles(dir: string): Record<string, string> {
    return Object.fromEntries(
        fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.deepnote'))
            .sort()
            .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')])
    );
}

function emptyDir(dir: string, keep: string[] = []): void {
    for (const name of fs.readdirSync(dir)) {
        if (!keep.includes(name)) {
            fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
    }
}

describe('Deepnote Cloud — syncing folders with the mock Deepnote Cloud', function () {
    this.timeout(SUITE_TIMEOUT);

    let cloud: MockDeepnoteCloud | undefined;
    let cloudRootDir = '';
    let workspaceDir = '';

    function addCloudProject(project: { id: string }, notebooks: string[]): string {
        const dir = path.join(cloudRootDir, project.id);
        fs.mkdirSync(dir);
        for (const notebook of notebooks) {
            copyFixtureIntoDir(dir, notebook);
        }

        return dir;
    }

    // A token in the folder's `.env` is read before a saved one, so no test depends on the test that saves one.
    function addLocalFolder(name: string, { withToken = true } = {}): string {
        const dir = path.join(workspaceDir, name);
        fs.mkdirSync(dir);
        if (withToken) {
            fs.writeFileSync(path.join(dir, '.env'), `DEEPNOTE_TOKEN=${API_TOKEN}\n`);
        }

        return dir;
    }

    before(async function () {
        cloud = await startMockDeepnoteCloud();
        cloudRootDir = cloud.rootDir;

        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-cloud-'));
        fs.mkdirSync(path.join(workspaceDir, '.vscode'));
        fs.writeFileSync(
            path.join(workspaceDir, '.vscode', 'settings.json'),
            JSON.stringify({ 'deepnote.apiUrl': cloud.url })
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(workspaceDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
    });

    afterEach(async function () {
        // Mocha leaves `state` unset on an attempt it is about to retry.
        if (this.currentTest?.state !== 'passed') {
            await closeLeftoverPrompts();
        }
        await new EditorView().closeAllEditors().catch(() => undefined);
        if (cloudRootDir) {
            emptyDir(cloudRootDir);
        }
        if (workspaceDir) {
            emptyDir(workspaceDir, ['.vscode']);
        }
    });

    after(async function () {
        await cloud?.stop();
        if (workspaceDir) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it('offers to sync a new folder when none is synced, then downloads every project and notebook into it', async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        const mainCloudDir = addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');

        let offer = '';
        const summary = await sync(SYNC, async () => {
            const notification = await waitForNotification(/^No folder in this workspace/, WORKBENCH_TIMEOUT, true);
            offer = (await notification?.getMessage()) ?? '';
            await notification?.takeAction('Sync a New Folder…');
            await chooseFolderInDialog(alpha);
            await confirmModalDialog('Download Projects', { messageIncludes: 'into alpha?' });
        });

        expect(offer).to.equal('No folder in this workspace is synced with Deepnote Cloud yet.');
        expect(summary).to.equal('Sync finished: 2 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(Object.keys(readNotebookFiles(path.join(alpha, ANALYTICS.name)))).to.deep.equal([COSTS, REVENUE]);
        expect(readNotebookFiles(path.join(alpha, ANALYTICS.name))).to.deep.equal(readNotebookFiles(analyticsCloudDir));
        expect(readNotebookFiles(path.join(alpha, MAIN.name))).to.deep.equal(readNotebookFiles(mainCloudDir));
    });

    it('pushes an edited and a new notebook of a project without asking which folder to sync', async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        const analyticsDir = path.join(alpha, ANALYTICS.name);
        replaceInFile(path.join(analyticsDir, REVENUE), REVENUE_TEXT, LOCAL_EDIT);
        copyFixtureIntoDir(analyticsDir, FORECAST);
        // Read before syncing: after a push, sync downloads the project again over the local files.
        const localNotebooks = readNotebookFiles(analyticsDir);

        const summary = await sync(SYNC, NO_PROMPTS);

        expect(summary).to.equal('Sync finished: 0 pulled, 1 pushed, 1 unchanged, 0 skipped, 0 failed.');
        expect(Object.keys(readNotebookFiles(analyticsCloudDir))).to.deep.equal([COSTS, FORECAST, REVENUE]);
        expect(readNotebookFiles(analyticsCloudDir)).to.deep.equal(localNotebooks);
    });

    it('mirrors notebooks edited, added and deleted in Deepnote', async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        replaceInFile(path.join(analyticsCloudDir, REVENUE), REVENUE_TEXT, CLOUD_EDIT);
        copyFixtureIntoDir(analyticsCloudDir, FORECAST);
        fs.rmSync(path.join(analyticsCloudDir, COSTS));

        const summary = await sync(SYNC, NO_PROMPTS);

        const analyticsDir = path.join(alpha, ANALYTICS.name);
        expect(summary).to.equal('Sync finished: 1 pulled, 0 pushed, 1 unchanged, 0 skipped, 0 failed.');
        expect(Object.keys(readNotebookFiles(analyticsDir))).to.deep.equal([FORECAST, REVENUE]);
        expect(readNotebookFiles(analyticsDir)).to.deep.equal(readNotebookFiles(analyticsCloudDir));
    });

    it('replaces local edits with the Deepnote version when the user picks it in a conflict', async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        const analyticsDir = path.join(alpha, ANALYTICS.name);
        replaceInFile(path.join(analyticsDir, REVENUE), REVENUE_TEXT, LOCAL_EDIT);
        replaceInFile(path.join(analyticsCloudDir, REVENUE), REVENUE_TEXT, CLOUD_EDIT);

        const summary = await sync(SYNC, () =>
            confirmModalDialog('Use Deepnote Version, Discard Local Changes', { messageIncludes: BOTH_SIDES_CHANGED })
        );

        expect(summary).to.equal('Sync finished: 1 pulled, 0 pushed, 1 unchanged, 0 skipped, 0 failed.');
        expect(readNotebookFiles(analyticsDir)).to.deep.equal(readNotebookFiles(analyticsCloudDir));
        expect(fs.readFileSync(path.join(analyticsDir, REVENUE), 'utf8')).to.contain(CLOUD_EDIT);
    });

    it('asks only about the project changed on both sides, and keeps its local edits when skipped', async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        const mainCloudDir = addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        replaceInFile(path.join(alpha, ANALYTICS.name, REVENUE), REVENUE_TEXT, LOCAL_EDIT);
        replaceInFile(path.join(analyticsCloudDir, REVENUE), REVENUE_TEXT, CLOUD_EDIT);
        replaceInFile(path.join(alpha, MAIN.name, MAIN_NOTEBOOK), MAIN_TEXT, LOCAL_EDIT);

        const summary = await sync(SYNC, () => confirmModalDialog('Skip', { messageIncludes: BOTH_SIDES_CHANGED }));

        expect(summary).to.equal('Sync finished: 0 pulled, 1 pushed, 0 unchanged, 1 skipped, 0 failed.');
        expect(fs.readFileSync(path.join(alpha, ANALYTICS.name, REVENUE), 'utf8')).to.contain(LOCAL_EDIT);
        expect(fs.readFileSync(path.join(analyticsCloudDir, REVENUE), 'utf8')).to.contain(CLOUD_EDIT);
        expect(fs.readFileSync(path.join(mainCloudDir, MAIN_NOTEBOOK), 'utf8')).to.contain(LOCAL_EDIT);
    });

    it('asks which synced folder to sync, listing the folder of the active editor first', async function () {
        const mainCloudDir = addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');
        const beta = addLocalFolder('beta');
        await syncNewFolder(alpha);
        await syncNewFolder(beta);
        replaceInFile(path.join(beta, MAIN.name, MAIN_NOTEBOOK), MAIN_TEXT, LOCAL_EDIT);
        fs.writeFileSync(path.join(beta, NOTES_FILE), 'Opened to make beta the active folder.\n');
        await openWorkspaceFile(NOTES_FILE);

        let labels: string[] = [];
        const summary = await sync(SYNC, async () => {
            labels = await readFolderPick();
            await (await InputBox.create(QUICK_PICK_TIMEOUT)).selectQuickPick(0);
        });

        expect(labels).to.deep.equal(['beta', 'alpha']);
        expect(summary).to.equal('Sync finished: 0 pulled, 1 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(fs.readFileSync(path.join(mainCloudDir, MAIN_NOTEBOOK), 'utf8')).to.contain(LOCAL_EDIT);
    });

    it('keeps and reports local notebooks outside every project and projects deleted in Deepnote', async function () {
        addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        const mainCloudDir = addCloudProject(MAIN, [MAIN_NOTEBOOK]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        fs.rmSync(mainCloudDir, { recursive: true });
        const untracked = copyFixtureIntoDir(alpha, UNTRACKED);

        const summary = await sync(SYNC, NO_PROMPTS);

        expect(summary).to.equal(
            'Sync finished: 0 pulled, 0 pushed, 1 unchanged, 0 skipped, 0 failed. ' +
                '1 project(s) no longer in Deepnote were kept locally. ' +
                '1 local .deepnote file(s) are not linked to a Deepnote project and were not uploaded.'
        );
        expect(Object.keys(readNotebookFiles(path.join(alpha, MAIN.name)))).to.deep.equal([MAIN_NOTEBOOK]);
        expect(fs.existsSync(untracked)).to.equal(true);
    });

    it("does not upload a project's .files directory", async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        const analyticsDir = path.join(alpha, ANALYTICS.name);
        fs.mkdirSync(path.join(analyticsDir, '.files'));
        fs.writeFileSync(path.join(analyticsDir, '.files', WORKING_FILE), WORKING_FILE_CONTENT);
        replaceInFile(path.join(analyticsDir, REVENUE), REVENUE_TEXT, LOCAL_EDIT);

        const summary = await sync(SYNC, NO_PROMPTS);

        expect(summary).to.equal('Sync finished: 0 pulled, 1 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(fs.existsSync(path.join(analyticsCloudDir, '.files'))).to.equal(false);
    });

    it("keeps a project's .files directory when pulling the project", async function () {
        const analyticsCloudDir = addCloudProject(ANALYTICS, [REVENUE, COSTS]);
        const alpha = addLocalFolder('alpha');
        await syncNewFolder(alpha);
        const workingFile = path.join(alpha, ANALYTICS.name, '.files', WORKING_FILE);
        fs.mkdirSync(path.dirname(workingFile));
        fs.writeFileSync(workingFile, WORKING_FILE_CONTENT);
        replaceInFile(path.join(analyticsCloudDir, REVENUE), REVENUE_TEXT, CLOUD_EDIT);

        const summary = await sync(SYNC, NO_PROMPTS);

        expect(summary).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(fs.readFileSync(path.join(alpha, ANALYTICS.name, REVENUE), 'utf8')).to.contain(CLOUD_EDIT);
        expect(fs.readFileSync(workingFile, 'utf8')).to.equal(WORKING_FILE_CONTENT);
    });

    describe('with a token saved by Set API Token', function () {
        // Wherever this test runs, the other tests must sync with the token in their folder's `.env` alone.
        after(clearApiToken);

        it('saves the API token, names the Deepnote workspace that accepted it, and syncs with it', async function () {
            const cloudDir = addCloudProject(MAIN, [MAIN_NOTEBOOK]);
            const alpha = addLocalFolder('alpha', { withToken: false });

            const tokenMessage = await setApiToken();
            const summary = await syncNewFolder(alpha);

            expect(tokenMessage).to.equal(`Signed in to the Deepnote workspace "${MOCK_WORKSPACE_NAME}". Token saved.`);
            expect(summary).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
            expect(readNotebookFiles(path.join(alpha, MAIN.name))).to.deep.equal(readNotebookFiles(cloudDir));
        });
    });
});
