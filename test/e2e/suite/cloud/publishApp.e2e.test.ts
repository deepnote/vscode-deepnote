import { startMockDeepnoteCloud, type MockDeepnoteCloud } from '@deepnote/cloud-mock';
import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    EditorView,
    InputBox,
    NotificationType,
    SideBarView,
    VSBrowser,
    Workbench,
    type ViewItem
} from 'vscode-extension-tester';

import {
    API_TOKEN,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    closeModalDialogs,
    confirmModalDialog,
    copyFixtureIntoDir,
    emptyDir,
    openActivityBarView,
    openFolderViaDialog,
    selectDeepnoteContextMenu,
    setApiToken
} from '../../helpers';

const FIXTURE = 'cloud-sync.deepnote';
const PROJECT_ID = '4f0c2a8e-6b1d-4c3e-9a7f-2d5e8b1c0a93';
const PROJECT_NAME = 'E2E Cloud Sync';
const STANDARD_FIXTURE = 'cloud-sync-analytics-costs.deepnote';
const STANDARD_PROJECT_ID = '8b3e1f6a-2c4d-4e5f-9a7b-1c3d5e7f9a2b';
const NEW_APP_NAME = 'E2E New App';
const SYNCED_PROJECT_DIR = 'Sales';
const CHOOSE_PROJECT = 'Choose the data app to publish to';
const NEW_DATA_APP = 'New Data App…';
const PUBLISH_OUTCOME = /^(App published|Publishing the app failed)/;
const PUBLISH_PROGRESS = /^Publishing .+ to Deepnote…/;
const LEFTOVER_PUBLISH_TIMEOUT = 30_000;
const APP_FILE = path.join('.files', '_deepnote_static', 'index.html');

interface PublishedProject {
    name: string;
    dataApp: { published: boolean; url: string } | null;
}

/**
 * VS Code reuses one quick-pick widget, so the previous quick pick can still be on screen until `placeHolder` shows.
 * Clicking an item while the list is being replaced can close the quick pick without accepting it, so the item is
 * filtered down to and accepted with Enter instead.
 */
async function pick(placeHolder: string, label: string): Promise<string[]> {
    const driver = VSBrowser.instance.driver;
    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await driver.wait(
        async () => (await input.getPlaceHolder().catch(() => '')) === placeHolder,
        QUICK_PICK_TIMEOUT,
        `the quick pick "${placeHolder}" did not open`
    );
    let listed: string[] = [];
    await driver.wait(
        async () => {
            const items = await input.getQuickPicks().catch(() => []);
            listed = await Promise.all(items.map((item) => item.getLabel().catch(() => '')));

            return listed.includes(label);
        },
        QUICK_PICK_TIMEOUT,
        `the quick pick "${placeHolder}" did not list "${label}"`
    );

    await input.setText(label);
    await driver.wait(
        async () => {
            const items = await input.getQuickPicks().catch(() => []);

            return items.length === 1 && (await items[0].getLabel().catch(() => '')) === label;
        },
        QUICK_PICK_TIMEOUT,
        `"${label}" is not the only match in the quick pick "${placeHolder}"`
    );
    await input.confirm();

    return listed;
}

async function enterNewAppName(name: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await driver.wait(
        async () => (await input.getTitle().catch(() => '')) === NEW_DATA_APP,
        QUICK_PICK_TIMEOUT,
        'the new data app name prompt did not open'
    );
    await input.setText(name);
    await input.confirm();
}

async function findExplorerItem(folderPath: string): Promise<ViewItem> {
    await openActivityBarView('Explorer');
    const segments = folderPath.split('/');
    const label = segments[segments.length - 1];
    let found: ViewItem | undefined;
    await VSBrowser.instance.driver.wait(
        async () => {
            for (const section of await new SideBarView().getContent().getSections()) {
                if (segments.length > 1) {
                    await section.openItem(...segments.slice(0, -1)).catch(() => undefined);
                }
                found = await section.findItem(label, segments.length).catch(() => undefined);
                if (found) {
                    return true;
                }
            }

            return false;
        },
        WORKBENCH_TIMEOUT,
        `"${folderPath}" did not appear in the file explorer`
    );

    return found!;
}

/** Clicks the explorer's own action, since the command palette also lists the extension's "Deepnote: Refresh Explorer". */
async function refreshExplorer(): Promise<void> {
    const [section] = await new SideBarView().getContent().getSections();
    const refresh = await section.getAction('Refresh Explorer');
    if (!refresh) {
        throw new Error('the explorer has no Refresh Explorer action');
    }
    await refresh.click();
}

/**
 * A toast hides itself after about ten seconds, which one slow poll of the toasts can outlast, so the outcome is read
 * from the Notifications Center, which keeps it.
 */
async function waitForPublishOutcome(): Promise<string> {
    const center = await new Workbench().openNotificationsCenter();
    let message = '';
    try {
        await VSBrowser.instance.driver.wait(
            async () => {
                for (const notification of await center.getNotifications(NotificationType.Any).catch(() => [])) {
                    message = await notification.getMessage().catch(() => '');
                    if (PUBLISH_OUTCOME.test(message)) {
                        return true;
                    }
                }

                return false;
            },
            WORKBENCH_TIMEOUT,
            `no notification matching ${PUBLISH_OUTCOME}`
        );
    } finally {
        await center.close().catch(() => undefined);
    }

    return message;
}

/**
 * A publish that a failed test left running cannot be cancelled, still reads the app folder the hook is about to
 * empty, and for a synced folder holds the operation lock, which refuses the next synced publish. VS Code removes
 * toasts when the Notifications Center opens, as this suite does around every publish, so its progress is read there.
 */
async function waitForLeftoverPublish(): Promise<void> {
    const center = await new Workbench().openNotificationsCenter();
    try {
        await VSBrowser.instance.driver.wait(async () => {
            const notifications = await center.getNotifications(NotificationType.Any).catch(() => undefined);
            if (!notifications) {
                return false;
            }
            for (const notification of notifications) {
                const message = await notification.getMessage().catch(() => undefined);
                if (message === undefined || PUBLISH_PROGRESS.test(message)) {
                    return false;
                }
            }

            return true;
        }, LEFTOVER_PUBLISH_TIMEOUT);
    } finally {
        await center.close().catch(() => undefined);
    }
}

async function publishFromExplorer(folderPath: string, answerPrompts: () => Promise<void>): Promise<string> {
    // Every publish of a folder ends with the same message, so one left from the previous publish must not count.
    await (await new Workbench().openNotificationsCenter()).clearAllNotifications();
    await selectDeepnoteContextMenu(await findExplorerItem(folderPath), 'Publish App…');
    await answerPrompts();

    const message = await waitForPublishOutcome();
    if (!message.startsWith('App published')) {
        throw new Error(message);
    }

    return message;
}

describe('Deepnote Cloud — publishing an app to the mock Deepnote Cloud', function () {
    this.timeout(SUITE_TIMEOUT);

    let cloud: MockDeepnoteCloud | undefined;
    let workspaceDir = '';

    function addCloudProject(projectId: string, fixture: string, { dataApp = true } = {}): string {
        const dir = path.join(cloud!.rootDir, projectId);
        fs.mkdirSync(dir);
        copyFixtureIntoDir(dir, fixture);
        if (dataApp) {
            fs.writeFileSync(path.join(dir, '.data-app'), '');
        }

        return dir;
    }

    /**
     * The extension saves each folder's data app in workspace state, keyed by path, which `emptyDir` does not clear, so
     * every app folder gets a name no earlier test, or earlier attempt of the same test, has published.
     */
    function addAppFolder(html: string): string {
        const dir = fs.mkdtempSync(path.join(workspaceDir, 'app-'));
        fs.writeFileSync(path.join(dir, 'index.html'), html);

        return dir;
    }

    async function readProject(projectId: string): Promise<PublishedProject> {
        const response = await fetch(`${cloud!.url}/v2/projects/${projectId}`, {
            headers: { Authorization: `Bearer ${API_TOKEN}` }
        });

        return ((await response.json()) as { project: PublishedProject }).project;
    }

    before(async function () {
        cloud = await startMockDeepnoteCloud();

        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-publish-'));
        fs.mkdirSync(path.join(workspaceDir, '.vscode'));
        fs.writeFileSync(
            path.join(workspaceDir, '.vscode', 'settings.json'),
            // Compact folders would merge `Sales/app` into one row, so a right-click could target `Sales`.
            JSON.stringify({ 'deepnote.apiUrl': cloud.url, 'explorer.compactFolders': false })
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(workspaceDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await setApiToken();
    });

    afterEach(async function () {
        // Mocha leaves `state` unset on an attempt it is about to retry.
        if (this.currentTest?.state !== 'passed') {
            // A prompt left open by a failed test would block the next one. Closing it ends that publish.
            await closeModalDialogs();
            await new InputBox().cancel().catch(() => undefined);
            await waitForLeftoverPublish().catch((error) => {
                console.warn('[cloud-publish] a publish left behind by a failed test did not end:', error);
            });
        }
        await new EditorView().closeAllEditors().catch(() => undefined);
        if (cloud) {
            emptyDir(cloud.rootDir);
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

    it('lists only data apps, publishes a folder to the picked one, and shows the app URL', async function () {
        const cloudDir = addCloudProject(PROJECT_ID, FIXTURE);
        addCloudProject(STANDARD_PROJECT_ID, STANDARD_FIXTURE, { dataApp: false });
        const appDir = addAppFolder('<h1>site v1</h1>');

        let listed: string[] = [];
        const outcome = await publishFromExplorer(path.basename(appDir), async () => {
            listed = await pick(CHOOSE_PROJECT, PROJECT_NAME);
        });

        expect(listed).to.deep.equal([NEW_DATA_APP, PROJECT_NAME]);
        expect(outcome).to.equal(`App published: ${cloud!.url}/apps/${PROJECT_ID}/`);
        expect(fs.readFileSync(path.join(cloudDir, APP_FILE), 'utf8')).to.equal('<h1>site v1</h1>');
        expect((await readProject(PROJECT_ID)).dataApp).to.deep.equal({
            published: true,
            url: `${cloud!.url}/apps/${PROJECT_ID}/`
        });
    });

    it('republishes with the saved data app after one confirmation', async function () {
        const cloudDir = addCloudProject(PROJECT_ID, FIXTURE);
        const appDir = addAppFolder('<h1>site v1</h1>');
        const folder = path.basename(appDir);
        await publishFromExplorer(folder, async () => {
            await pick(CHOOSE_PROJECT, PROJECT_NAME);
        });
        fs.writeFileSync(path.join(appDir, 'index.html'), '<h1>site v2</h1>');

        const outcome = await publishFromExplorer(folder, () =>
            confirmModalDialog('Publish', { messageIncludes: `Publish ${folder} to ${PROJECT_NAME}?` })
        );

        expect(outcome).to.equal(`App published: ${cloud!.url}/apps/${PROJECT_ID}/`);
        expect(fs.readFileSync(path.join(cloudDir, APP_FILE), 'utf8')).to.equal('<h1>site v2</h1>');
    });

    it('creates a data app with New Data App… and publishes the folder to it', async function () {
        addCloudProject(PROJECT_ID, FIXTURE);
        const appDir = addAppFolder('<h1>new app</h1>');

        const outcome = await publishFromExplorer(path.basename(appDir), async () => {
            await pick(CHOOSE_PROJECT, NEW_DATA_APP);
            await enterNewAppName(NEW_APP_NAME);
        });

        const newAppId = /\/apps\/([^/]+)\/$/.exec(outcome)?.[1] ?? '';
        expect(newAppId).to.not.be.oneOf(['', PROJECT_ID]);
        expect(await readProject(newAppId)).to.deep.include({
            name: NEW_APP_NAME,
            dataApp: { published: true, url: `${cloud!.url}/apps/${newAppId}/` }
        });
        expect(fs.readFileSync(path.join(cloud!.rootDir, newAppId, APP_FILE), 'utf8')).to.equal('<h1>new app</h1>');
    });

    it('overwrites app files changed in Deepnote when the user picks Force', async function () {
        const cloudDir = addCloudProject(PROJECT_ID, FIXTURE);
        const syncedAppFile = path.join(workspaceDir, 'synced', SYNCED_PROJECT_DIR, 'app', 'index.html');
        fs.mkdirSync(path.dirname(syncedAppFile), { recursive: true });
        fs.writeFileSync(syncedAppFile, '<h1>synced app</h1>');
        fs.writeFileSync(
            path.join(workspaceDir, 'synced', '.deepnote-sync.json'),
            JSON.stringify({
                version: 1,
                projects: { [PROJECT_ID]: { dir: SYNCED_PROJECT_DIR, notebooks: [], contentHash: 'x' } }
            })
        );
        const syncedApp = `synced/${SYNCED_PROJECT_DIR}/app`;
        const confirmSyncedPublish = () =>
            confirmModalDialog('Publish', { messageIncludes: `Publish app to ${SYNCED_PROJECT_DIR}?` });
        await publishFromExplorer(syncedApp, confirmSyncedPublish);
        // The publish mirrored the app into the synced project's `.files`, which sorts above the app folder. The
        // explorer misses that change in a folder created after the workspace opened. Once it shows `.files`, its rows
        // stop moving, so the next right-click lands on the app folder.
        await refreshExplorer();
        await findExplorerItem(`synced/${SYNCED_PROJECT_DIR}/.files`);
        fs.writeFileSync(path.join(cloudDir, APP_FILE), '<h1>edited in Deepnote</h1>');

        const outcome = await publishFromExplorer(syncedApp, async () => {
            await confirmSyncedPublish();
            await confirmModalDialog('Force', { messageIncludes: 'changed in Deepnote since the last sync' });
        });

        expect(outcome).to.equal(`App published: ${cloud!.url}/apps/${PROJECT_ID}/`);
        expect(fs.readFileSync(path.join(cloudDir, APP_FILE), 'utf8')).to.equal('<h1>synced app</h1>');
    });
});
