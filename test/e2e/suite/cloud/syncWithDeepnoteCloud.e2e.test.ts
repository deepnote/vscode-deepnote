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
    openWorkspaceFile,
    waitForNotification
} from '../../helpers';
import { MOCK_WORKSPACE_NAME, startMockDeepnoteCloud, type MockDeepnoteCloud } from '../../helpers/mockDeepnoteCloud';

const API_TOKEN = 'e2e_mock_token';
const SYNC = 'Deepnote: Sync with Deepnote Cloud';
const SYNC_NEW_FOLDER = 'Deepnote: Sync a New Folder with Deepnote Cloud…';
const FIXTURE = 'cloud-sync.deepnote';
const NOTES_FILE = 'beta-notes.txt';
const PROJECT_ID = '4f0c2a8e-6b1d-4c3e-9a7f-2d5e8b1c0a93';
const PROJECT_NAME = 'E2E Cloud Sync';
const CLOUD_TEXT = 'synced from Deepnote';
const LOCAL_EDIT = 'edited locally';
const CONFLICTING_LOCAL_EDIT = 'edited locally again';
const CONFLICTING_CLOUD_EDIT = 'edited in Deepnote';

async function sync(command: string, answerPrompts: () => Promise<void>): Promise<string> {
    await dismissAllNotifications();
    await new Workbench().executeCommand(command);
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

async function setApiToken(): Promise<string> {
    await dismissAllNotifications();
    await new Workbench().executeCommand('Deepnote: Set API Token');
    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await input.setText(API_TOKEN);
    await input.confirm();

    const outcome = await waitForNotification(
        /^(Signed in to the Deepnote workspace|Deepnote API token saved|Deepnote rejected|Could not check|Could not save)/,
        WORKBENCH_TIMEOUT,
        true
    );
    const message = (await outcome?.getMessage()) ?? '';
    if (/^(Deepnote rejected|Could not)/.test(message)) {
        throw new Error(message);
    }

    return message;
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

describe('Deepnote Cloud — syncing a folder with the mock Deepnote Cloud', function () {
    this.timeout(SUITE_TIMEOUT);

    let cloud: MockDeepnoteCloud | undefined;
    let workspaceDir = '';
    let tokenSavedMessage = '';
    let offerMessage = '';
    const summaries: string[] = [];
    let pulledContent = '';
    let cloudContentAfterPush = '';
    let localContentAfterConflict = '';
    let secondFolderContent = '';
    let folderPickLabels: string[] = [];

    before(async function () {
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
        const alphaDir = path.join(workspaceDir, 'alpha');
        const betaDir = path.join(workspaceDir, 'beta');
        fs.mkdirSync(alphaDir);
        fs.mkdirSync(betaDir);
        fs.writeFileSync(path.join(betaDir, NOTES_FILE), 'Opened to make beta the active folder.\n');
        const localFile = path.join(alphaDir, PROJECT_NAME, FIXTURE);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(workspaceDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        tokenSavedMessage = await setApiToken();

        summaries.push(
            await sync(SYNC, async () => {
                const offer = await waitForNotification(/^No folder in this workspace/, WORKBENCH_TIMEOUT, true);
                offerMessage = (await offer?.getMessage()) ?? '';
                await offer?.takeAction('Sync a New Folder…');
                await chooseFolderInDialog(alphaDir);
                await confirmModalDialog('Download Projects', { messageIncludes: 'into alpha?' });
            })
        );
        pulledContent = fs.readFileSync(localFile, 'utf8');

        replaceInFile(localFile, CLOUD_TEXT, LOCAL_EDIT);
        // No answers: a folder pick would stay open, and the summary would never appear.
        summaries.push(await sync(SYNC, async () => undefined));
        cloudContentAfterPush = fs.readFileSync(cloudFile, 'utf8');

        replaceInFile(localFile, LOCAL_EDIT, CONFLICTING_LOCAL_EDIT);
        replaceInFile(cloudFile, LOCAL_EDIT, CONFLICTING_CLOUD_EDIT);
        summaries.push(
            await sync(SYNC, async () => {
                await confirmModalDialog('Use Deepnote Version, Discard Local Changes', {
                    messageIncludes: 'changed both locally and in Deepnote'
                });
            })
        );
        localContentAfterConflict = fs.readFileSync(localFile, 'utf8');

        summaries.push(
            await sync(SYNC_NEW_FOLDER, async () => {
                await chooseFolderInDialog(betaDir);
                await confirmModalDialog('Download Projects', { messageIncludes: 'into beta?' });
            })
        );
        secondFolderContent = fs.readFileSync(path.join(betaDir, PROJECT_NAME, FIXTURE), 'utf8');

        await openWorkspaceFile(NOTES_FILE);
        summaries.push(
            await sync(SYNC, async () => {
                folderPickLabels = await readFolderPick();
                await (await InputBox.create(QUICK_PICK_TIMEOUT)).selectQuickPick(0);
            })
        );
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

    it('offers to sync a new folder when no folder is synced yet', function () {
        expect(offerMessage).to.equal('No folder in this workspace is synced with Deepnote Cloud yet.');
    });

    it('downloads the cloud project into the folder chosen from the offer', function () {
        expect(summaries[0]).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(pulledContent).to.contain(CLOUD_TEXT);
    });

    it('pushes a local edit, syncing the only synced folder without asking', function () {
        expect(summaries[1]).to.equal('Sync finished: 0 pulled, 1 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(cloudContentAfterPush).to.contain(LOCAL_EDIT);
    });

    it('replaces local edits with the cloud version when the user picks it in a conflict', function () {
        expect(summaries[2]).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(localContentAfterConflict).to.contain(CONFLICTING_CLOUD_EDIT);
        expect(localContentAfterConflict).to.not.contain(CONFLICTING_LOCAL_EDIT);
    });

    it('downloads the cloud project into a second folder with Sync a New Folder', function () {
        expect(summaries[3]).to.equal('Sync finished: 1 pulled, 0 pushed, 0 unchanged, 0 skipped, 0 failed.');
        expect(secondFolderContent).to.contain(CONFLICTING_CLOUD_EDIT);
    });

    it('asks which synced folder to sync, listing the folder of the active editor first', function () {
        expect(folderPickLabels).to.deep.equal(['beta', 'alpha']);
        expect(summaries[4]).to.equal('Sync finished: 0 pulled, 0 pushed, 1 unchanged, 0 skipped, 0 failed.');
    });
});
