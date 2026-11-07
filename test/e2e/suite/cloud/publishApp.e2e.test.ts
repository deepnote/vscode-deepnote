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
    confirmModalDialog,
    copyFixtureIntoDir,
    openActivityBarView,
    openFolderViaDialog,
    selectDeepnoteContextMenu,
    setApiToken
} from '../../helpers';
import { startMockDeepnoteCloud, type MockDeepnoteCloud } from '../../helpers/mockDeepnoteCloud';

const FIXTURE = 'cloud-sync.deepnote';
const PROJECT_ID = '4f0c2a8e-6b1d-4c3e-9a7f-2d5e8b1c0a93';
const PROJECT_NAME = 'E2E Cloud Sync';
const SYNCED_PROJECT_DIR = 'Sales';
const CHOOSE_PROJECT = 'Choose the Deepnote project to publish to';
const CHOOSE_API_ACCESS = 'Should the app be able to call the Deepnote API?';
const PUBLISH_OUTCOME = /^(App published|Publishing the app failed)/;

interface StaticFiles {
    apiAccessEnabled: boolean;
    sharingEnabled: boolean;
}

/**
 * VS Code reuses one quick-pick widget, so the previous quick pick can still be on screen until `placeHolder` shows.
 * Clicking an item while the list is being replaced can close the quick pick without accepting it, so the item is
 * filtered down to and accepted with Enter instead.
 */
async function pick(placeHolder: string, label: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await driver.wait(
        async () => (await input.getPlaceHolder().catch(() => '')) === placeHolder,
        QUICK_PICK_TIMEOUT,
        `the quick pick "${placeHolder}" did not open`
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
    let cloudAppFile = '';
    const outcomes: string[] = [];
    const cloudContent: string[] = [];
    let staticFilesAfterFirstPublish: StaticFiles | undefined;

    async function readStaticFiles(): Promise<StaticFiles> {
        const response = await fetch(`${cloud!.url}/v2/projects/${PROJECT_ID}`, {
            headers: { Authorization: `Bearer ${API_TOKEN}` }
        });

        return ((await response.json()) as { project: { staticFiles: StaticFiles } }).project.staticFiles;
    }

    before(async function () {
        cloud = await startMockDeepnoteCloud();
        const cloudProjectDir = path.join(cloud.rootDir, PROJECT_ID);
        fs.mkdirSync(cloudProjectDir);
        copyFixtureIntoDir(cloudProjectDir, FIXTURE);
        cloudAppFile = path.join(cloudProjectDir, 'files', '_deepnote_static', 'index.html');

        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-publish-'));
        fs.mkdirSync(path.join(workspaceDir, '.vscode'));
        fs.writeFileSync(
            path.join(workspaceDir, '.vscode', 'settings.json'),
            // Compact folders would merge `Sales/app` into one row, so a right-click could target `Sales`.
            JSON.stringify({ 'deepnote.apiUrl': cloud.url, 'explorer.compactFolders': false })
        );
        const siteFile = path.join(workspaceDir, 'site', 'index.html');
        fs.mkdirSync(path.dirname(siteFile));
        fs.writeFileSync(siteFile, '<h1>site v1</h1>');
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

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(workspaceDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await setApiToken();

        outcomes.push(
            await publishFromExplorer('site', async () => {
                await pick(CHOOSE_PROJECT, PROJECT_NAME);
                await pick(CHOOSE_API_ACCESS, 'API access on');
            })
        );
        cloudContent.push(fs.readFileSync(cloudAppFile, 'utf8'));
        staticFilesAfterFirstPublish = await readStaticFiles();

        fs.writeFileSync(siteFile, '<h1>site v2</h1>');
        outcomes.push(
            await publishFromExplorer('site', () =>
                confirmModalDialog('Publish', { messageIncludes: `Publish site to ${PROJECT_NAME}?` })
            )
        );
        cloudContent.push(fs.readFileSync(cloudAppFile, 'utf8'));

        const syncedApp = `synced/${SYNCED_PROJECT_DIR}/app`;
        outcomes.push(await publishFromExplorer(syncedApp, () => pick(CHOOSE_API_ACCESS, 'API access off')));
        // The publish mirrored the app into the synced project's `.files`. Once the explorer shows it, its rows
        // stop moving, so the next right-click lands on the app folder.
        await findExplorerItem(`synced/${SYNCED_PROJECT_DIR}/.files`);
        fs.writeFileSync(cloudAppFile, '<h1>edited in Deepnote</h1>');
        outcomes.push(
            await publishFromExplorer(syncedApp, async () => {
                await confirmModalDialog('Publish', { messageIncludes: `Publish app to ${SYNCED_PROJECT_DIR}?` });
                await confirmModalDialog('Force', { messageIncludes: 'changed in Deepnote since the last sync' });
            })
        );
        cloudContent.push(fs.readFileSync(cloudAppFile, 'utf8'));
    });

    after(async function () {
        await new EditorView().closeAllEditors().catch(() => undefined);
        await cloud?.stop();
        if (workspaceDir) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it('publishes a folder to the picked project with API access, and shows the app URL', function () {
        expect(outcomes[0]).to.equal(`App published: ${cloud!.url}/apps/${PROJECT_ID}/`);
        expect(cloudContent[0]).to.equal('<h1>site v1</h1>');
        expect(staticFilesAfterFirstPublish).to.include({ sharingEnabled: true, apiAccessEnabled: true });
    });

    it('republishes with the saved settings after one confirmation', function () {
        expect(outcomes[1]).to.equal(`App published: ${cloud!.url}/apps/${PROJECT_ID}/`);
        expect(cloudContent[1]).to.equal('<h1>site v2</h1>');
    });

    it('overwrites app files changed in Deepnote when the user picks Force', function () {
        expect(outcomes.slice(2)).to.deep.equal([
            `App published: ${cloud!.url}/apps/${PROJECT_ID}/`,
            `App published: ${cloud!.url}/apps/${PROJECT_ID}/`
        ]);
        expect(cloudContent[2]).to.equal('<h1>synced app</h1>');
    });
});
