import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EditorView, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickDialogOkButton,
    confirmModalDialog,
    copyFixtureIntoDir,
    dismissAllNotifications,
    openFolderViaDialog,
    setApiToken,
    waitForNotification
} from '../../helpers';
import { MOCK_WORKSPACE_NAME, startMockDeepnoteCloud, type MockDeepnoteCloud } from '../../helpers/mockDeepnoteCloud';

const FIXTURE = 'cloud-sync.deepnote';
const PROJECT_ID = '4f0c2a8e-6b1d-4c3e-9a7f-2d5e8b1c0a93';
const PROJECT_NAME = 'E2E Cloud Sync';
const CLOUD_TEXT = 'synced from Deepnote';
const LOCAL_EDIT = 'edited locally';
const CONFLICTING_LOCAL_EDIT = 'edited locally again';
const CONFLICTING_CLOUD_EDIT = 'edited in Deepnote';

async function sync(answerPrompts: () => Promise<void>): Promise<string> {
    await dismissAllNotifications();
    await new Workbench().executeCommand('Deepnote: Sync with Deepnote Cloud');
    await answerPrompts();

    const outcome = await waitForNotification(
        /^(Sync finished|Sync with Deepnote Cloud failed)/,
        WORKBENCH_TIMEOUT,
        true
    );
    const message = (await outcome?.getMessage()) ?? '';
    if (!message.startsWith('Sync finished')) {
        throw new Error(message);
    }

    return message;
}

function replaceInFile(file: string, from: string, to: string): void {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes(from)) {
        throw new Error(`"${from}" is not in ${file}`);
    }

    fs.writeFileSync(file, content.replace(from, to));
}

describe('Deepnote Cloud — syncing a folder with the mock Deepnote Cloud', function () {
    this.timeout(SUITE_TIMEOUT);

    let cloud: MockDeepnoteCloud | undefined;
    let workspaceDir = '';
    let tokenSavedMessage = '';
    const summaries: string[] = [];
    let pulledContent = '';
    let cloudContentAfterPush = '';
    let localContentAfterConflict = '';

    before(async function () {
        const driver = VSBrowser.instance.driver;

        cloud = await startMockDeepnoteCloud();
        const cloudProjectDir = path.join(cloud.rootDir, PROJECT_ID);
        fs.mkdirSync(cloudProjectDir);
        const cloudFile = copyFixtureIntoDir(cloudProjectDir, FIXTURE);

        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-cloud-'));
        fs.mkdirSync(path.join(workspaceDir, '.vscode'));
        fs.writeFileSync(
            path.join(workspaceDir, '.vscode', 'settings.json'),
            JSON.stringify({ 'deepnote.apiUrl': cloud.url })
        );
        const localFile = path.join(workspaceDir, PROJECT_NAME, FIXTURE);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(workspaceDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        tokenSavedMessage = await setApiToken();

        // No folder is synced yet, so the command opens the folder dialog at the workspace folder.
        summaries.push(
            await sync(async () => {
                await InputBox.create(QUICK_PICK_TIMEOUT);
                await driver.wait(
                    () => clickDialogOkButton('Sync Here'),
                    QUICK_PICK_TIMEOUT,
                    'the folder dialog did not accept the workspace folder'
                );
                await confirmModalDialog('Download Projects');
            })
        );
        pulledContent = fs.readFileSync(localFile, 'utf8');

        const pickSyncedFolder = async () => {
            await (await InputBox.create(QUICK_PICK_TIMEOUT)).selectQuickPick(0);
        };

        replaceInFile(localFile, CLOUD_TEXT, LOCAL_EDIT);
        summaries.push(await sync(pickSyncedFolder));
        cloudContentAfterPush = fs.readFileSync(cloudFile, 'utf8');

        replaceInFile(localFile, LOCAL_EDIT, CONFLICTING_LOCAL_EDIT);
        replaceInFile(cloudFile, LOCAL_EDIT, CONFLICTING_CLOUD_EDIT);
        summaries.push(
            await sync(async () => {
                await pickSyncedFolder();
                await confirmModalDialog('Use Deepnote Version, Discard Local Changes', {
                    messageIncludes: 'changed both locally and in Deepnote'
                });
            })
        );
        localContentAfterConflict = fs.readFileSync(localFile, 'utf8');
    });

    after(async function () {
        await new EditorView().closeAllEditors().catch(() => undefined);
        await cloud?.stop();
        if (workspaceDir) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    it('saves the API token and names the Deepnote workspace that accepted it', function () {
        expect(tokenSavedMessage).to.equal(
            `Signed in to the Deepnote workspace "${MOCK_WORKSPACE_NAME}". Token saved.`
        );
    });

    it('downloads the cloud project on the first sync', function () {
        expect(summaries[0]).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(pulledContent).to.contain(CLOUD_TEXT);
    });

    it('pushes a local edit to the cloud', function () {
        expect(summaries[1]).to.equal('Sync finished: 0 pulled, 1 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(cloudContentAfterPush).to.contain(LOCAL_EDIT);
    });

    it('replaces local edits with the cloud version when the user picks it in a conflict', function () {
        expect(summaries[2]).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(localContentAfterConflict).to.contain(CONFLICTING_CLOUD_EDIT);
        expect(localContentAfterConflict).to.not.contain(CONFLICTING_LOCAL_EDIT);
    });
});
