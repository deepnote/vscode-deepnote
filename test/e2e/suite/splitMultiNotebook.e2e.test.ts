/**
 * E2E (ExTester): the on-open split of the multi-notebook `sales-analytics.deepnote` (Overview,
 * Revenue, Forecast + a project BigQuery integration) into one single-notebook file per notebook.
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
    assertNotNull,
    showView,
    waitForNotification
} from '../helpers';

const FIXTURE = 'sales-analytics.deepnote';
const SPLIT_ACTION = 'Split into separate files';
const SPLIT_PROMPT = /multiple notebooks/i;
const SPLIT_DONE = /Split into \d+ files\./i;

// How long to wait while confirming a single-notebook file does NOT raise the split prompt.
const NO_SPLIT_PROMPT_TIMEOUT = 6_000;

const INTEGRATION_NAME = 'Sales BigQuery';

// The three single-notebook files the split should produce; each marker is unique to its source
// notebook, proving the right blocks landed in the right file.
const SIBLINGS: ReadonlyArray<{ file: string; notebookName: string; contentMarkers: string[] }> = [
    {
        file: 'sales-analytics-overview.deepnote',
        notebookName: 'Overview',
        contentMarkers: ['type: text-cell-h1', 'print("Overview notebook")']
    },
    {
        file: 'sales-analytics-revenue.deepnote',
        notebookName: 'Revenue',
        contentMarkers: ['type: sql', 'SELECT region, SUM(amount)']
    },
    {
        file: 'sales-analytics-forecast.deepnote',
        notebookName: 'Forecast',
        contentMarkers: ['print("Forecast notebook")']
    }
];

describe('Deepnote — splitting a legacy multi-notebook .deepnote file into single-notebook files', function () {
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
        // without one deserialization blocks on a warning that never resolves headlessly.
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await showView('Deepnote', '[split]');
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

        const prompt = assertNotNull(
            await waitForNotification(SPLIT_PROMPT, WORKBENCH_TIMEOUT, true),
            'split prompt notification'
        );
        promptMessage = (await prompt.getMessage()) ?? '';
        await screenshot('split-prompt');

        await prompt.takeAction(SPLIT_ACTION);

        // The original is retired by renaming to `<name>.deepnote.legacy` (deterministic, no OS trash
        // needed), and only after every child is written; "Failed to split" is a filesystem-error net.
        const outcome = assertNotNull(
            await waitForNotification(/Split into \d+ files\.|Failed to split/i, WORKBENCH_TIMEOUT, true),
            'split outcome notification'
        );
        outcomeMessage = (await outcome.getMessage()) ?? '';
        await driver.sleep(1500);
        await screenshot('split-outcome');

        originalRemoved = !fs.existsSync(path.join(tempDir, FIXTURE));
        legacyBackupExists = fs.existsSync(path.join(tempDir, `${FIXTURE}.legacy`));

        await showView('Deepnote', '[split]');
        await driver.sleep(1500);
        await screenshot('explorer-siblings');

        await showView('Explorer', '[split]');
        await driver.sleep(1500);
        await screenshot('file-explorer');
    });

    after(async function () {
        await new WebView().switchBack().catch((error) => {
            console.warn('[split] switch back from webview during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[split] close all editors during cleanup:', error);
        });
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[split] remove temp workspace dir during cleanup:', error);
        }
    });

    it('warns that the file contains multiple notebooks and offers to split it', function () {
        expect(promptMessage).to.match(SPLIT_PROMPT);
        expect(promptMessage).to.contain('one file per notebook');
    });

    it('splits into one single-notebook file per notebook and retires the original as a .legacy backup', function () {
        expect(outcomeMessage, 'split outcome notification').to.match(SPLIT_DONE);
        expect(originalRemoved, 'original .deepnote no longer present').to.equal(true);
        expect(legacyBackupExists, 'original retained as a .deepnote.legacy backup').to.equal(true);

        for (const sibling of SIBLINGS) {
            const siblingPath = path.join(tempDir, sibling.file);
            expect(fs.existsSync(siblingPath), `${sibling.file} should exist`).to.equal(true);

            const yaml = fs.readFileSync(siblingPath, 'utf8');
            expect(notebookCount(yaml), `${sibling.file} should contain exactly one notebook`).to.equal(1);
            expect(yaml, `${sibling.file} should hold the "${sibling.notebookName}" notebook`).to.contain(
                `name: ${sibling.notebookName}`
            );
        }
    });

    it('opens each split file directly, without prompting to split again', async function () {
        const driver = VSBrowser.instance.driver;

        for (const sibling of SIBLINGS) {
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

    it('preserves each source notebook’s content in its own split file', function () {
        for (const sibling of SIBLINGS) {
            const yaml = fs.readFileSync(path.join(tempDir, sibling.file), 'utf8');

            for (const marker of sibling.contentMarkers) {
                expect(yaml, `${sibling.file} should contain "${marker}"`).to.contain(marker);
            }
        }
    });

    it('carries the project integration into every split file', function () {
        for (const sibling of SIBLINGS) {
            const yaml = fs.readFileSync(path.join(tempDir, sibling.file), 'utf8');
            expect(yaml, `${sibling.file} should keep the "${INTEGRATION_NAME}" integration`).to.contain(
                `name: ${INTEGRATION_NAME}`
            );
        }
    });
});
