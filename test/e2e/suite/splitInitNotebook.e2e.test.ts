/**
 * E2E (ExTester): splitting the multi-notebook `etl-pipeline.deepnote` (init "Init" + mains "Extract"/
 * "Transform") emits the init notebook as its own sibling; every main keeps referencing it via initNotebookId.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    dismissAllNotifications,
    notebookCount,
    openFolderViaDialog,
    openWorkspaceFile,
    showView,
    waitForNotification
} from '../helpers';

const FIXTURE = 'etl-pipeline.deepnote';
const SPLIT_ACTION = 'Split into separate files';
const SPLIT_PROMPT = /contains multiple notebooks/i;
const SPLIT_DONE = /Split into \d+ files\./i;

// How long to wait while confirming a single-notebook file does NOT raise the split prompt.
const NO_SPLIT_PROMPT_TIMEOUT = 6_000;

// The fixture's `project.initNotebookId`; the init sibling's notebook id must equal this.
const INIT_NOTEBOOK_ID = 'b-nb-init';

const INIT_SIBLING = { file: 'etl-pipeline-init.deepnote', notebookName: 'Init' };

const MAIN_SIBLINGS: ReadonlyArray<{ file: string; notebookName: string }> = [
    { file: 'etl-pipeline-extract.deepnote', notebookName: 'Extract' },
    { file: 'etl-pipeline-transform.deepnote', notebookName: 'Transform' }
];

const ALL_SIBLINGS = [INIT_SIBLING, ...MAIN_SIBLINGS];

describe('Deepnote — splitting a legacy multi-notebook .deepnote file that has an init notebook', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let tempDir = '';
    let promptMessage = '';
    let outcomeMessage = '';
    let originalRemoved = false;
    let legacyBackupExists = false;

    before(async function () {
        const driver = VSBrowser.instance.driver;
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(FIXTURE);
        cleanupTempDir = copy.cleanup;
        tempDir = copy.tempDir;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the workspace folder FIRST: the serializer reads snapshots relative to it, and
        // without one deserialization blocks headlessly.
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await showView('Deepnote', '[split-init]');
        await screenshot('before-open-explorer');

        // Opening the multi-notebook file fires the splitter on the open event, raising the prompt.
        await openWorkspaceFile(FIXTURE);
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(FIXTURE)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
        await driver.sleep(2000);
        await screenshot('multinotebook-opened');

        const prompt = await waitForNotification(SPLIT_PROMPT, WORKBENCH_TIMEOUT, true);
        promptMessage = (await prompt!.getMessage()) ?? '';
        await screenshot('split-prompt');

        await prompt!.takeAction(SPLIT_ACTION);

        const outcome = await waitForNotification(/Split into \d+ files\.|Failed to split/i, WORKBENCH_TIMEOUT, true);
        outcomeMessage = (await outcome!.getMessage()) ?? '';
        await driver.sleep(1500);
        await screenshot('split-outcome');

        originalRemoved = !fs.existsSync(path.join(tempDir, FIXTURE));
        legacyBackupExists = fs.existsSync(path.join(tempDir, `${FIXTURE}.legacy`));

        await showView('Deepnote', '[split-init]');
        await driver.sleep(1500);
        await screenshot('explorer-siblings');

        await showView('Explorer', '[split-init]');
        await driver.sleep(1500);
        await screenshot('file-explorer');
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[split-init] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[split-init] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[split-init] remove temp workspace dir during cleanup:', error);
        }
    });

    it('warns that the file contains multiple notebooks and offers to split it', function () {
        expect(promptMessage).to.match(SPLIT_PROMPT);
        expect(promptMessage).to.contain('Split it into one file per notebook');
    });

    it('splits into one file per notebook (init + mains) and retires the original as a .legacy backup', function () {
        expect(outcomeMessage, 'split outcome notification').to.match(SPLIT_DONE);
        expect(originalRemoved, 'original .deepnote no longer present').to.equal(true);
        expect(legacyBackupExists, 'original retained as a .deepnote.legacy backup').to.equal(true);

        for (const sibling of ALL_SIBLINGS) {
            const siblingPath = path.join(tempDir, sibling.file);
            expect(fs.existsSync(siblingPath), `${sibling.file} should exist`).to.equal(true);
            expect(notebookCount(fs.readFileSync(siblingPath, 'utf8')), `${sibling.file} is single-notebook`).to.equal(
                1
            );
        }
    });

    it('gives the init notebook its own single-notebook sibling file', function () {
        const yaml = fs.readFileSync(path.join(tempDir, INIT_SIBLING.file), 'utf8');

        expect(yaml, 'init sibling holds the "Init" notebook').to.contain(`name: ${INIT_SIBLING.notebookName}`);
        expect(yaml, 'init sibling notebook id === initNotebookId').to.contain(`id: ${INIT_NOTEBOOK_ID}`);
        expect(yaml, 'init sibling declares the same initNotebookId').to.contain(`initNotebookId: ${INIT_NOTEBOOK_ID}`);
    });

    it('keeps each main sibling referencing the init notebook via initNotebookId', function () {
        for (const sibling of MAIN_SIBLINGS) {
            const yaml = fs.readFileSync(path.join(tempDir, sibling.file), 'utf8');
            expect(yaml, `${sibling.file} holds the "${sibling.notebookName}" notebook`).to.contain(
                `name: ${sibling.notebookName}`
            );
            expect(yaml, `${sibling.file} still references the init notebook`).to.contain(
                `initNotebookId: ${INIT_NOTEBOOK_ID}`
            );
        }
    });

    it('opens each split file directly, without prompting to split again', async function () {
        const driver = VSBrowser.instance.driver;

        for (const sibling of ALL_SIBLINGS) {
            await dismissAllNotifications();
            await openWorkspaceFile(sibling.file);
            await driver.wait(
                async () =>
                    (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(sibling.file)),
                WORKBENCH_TIMEOUT,
                `${sibling.file} did not open`
            );

            const reprompt = await waitForNotification(SPLIT_PROMPT, NO_SPLIT_PROMPT_TIMEOUT, false);
            expect(reprompt, `${sibling.file} is single-notebook and must not prompt to split`).to.equal(undefined);
        }
    });
});
