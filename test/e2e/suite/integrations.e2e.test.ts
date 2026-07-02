/**
 * End-to-end UI test (ExTester / vscode-extension-tester) for the Deepnote integrations UI. Opening
 * "Manage Integrations" for a notebook whose project declares an integration lists it; for a plain
 * notebook it does not. Fixtures:
 *   - `sales-analytics-revenue.deepnote` — a single-notebook file whose project carries a "Sales
 *     BigQuery" integration (and a SQL cell that references it).
 *   - `quick-notes.deepnote` — a plain single-notebook file with no integrations.
 *
 * Each `it` opens a notebook, runs "Manage Integrations", and reads the integrations webview.
 * Screenshots are captured into `test/e2e/screenshots/integrations/`. Runs without a Python kernel.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { By, EditorView, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureToTempDir,
    createScreenshotter,
    openFolderViaDialog,
    openWorkspaceFile
} from '../helpers';

const REVENUE_FILE = 'sales-analytics-revenue.deepnote';
const PLAIN_FILE = 'quick-notes.deepnote';
const INTEGRATION_NAME = 'Sales BigQuery';
const MANAGE_INTEGRATIONS = 'Deepnote: Manage Integrations';
const WEBVIEW_READ_TIMEOUT = 15_000;
// Empty-state text the integrations webview (IntegrationList.tsx) always renders for a project that
// has no integrations. Asserting on it proves the panel actually opened for the plain notebook,
// rather than the negative `not.contain` passing trivially against a blank/failed `''` read.
const NO_INTEGRATIONS_TEXT = 'No integrations found in this project.';

/** Opens a notebook, runs "Manage Integrations", and returns the integrations webview's text. */
async function openIntegrationsFor(fileName: string): Promise<string> {
    const driver = VSBrowser.instance.driver;

    // Start from a clean editor state: the integrations panel is reused, so a previous notebook's
    // webview lingers (and "Manage Integrations" needs the target notebook to be the ACTIVE editor,
    // not the still-open integrations panel).
    await new EditorView().closeAllEditors().catch(() => undefined);
    await driver.sleep(500);

    await openWorkspaceFile(fileName);
    await driver.wait(
        async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(fileName)),
        WORKBENCH_TIMEOUT,
        `${fileName} did not open`
    );
    await driver.sleep(1500);
    // Ensure the notebook (not some other tab) is the active editor before running the command.
    await new EditorView().openEditor(fileName).catch(() => undefined);
    await driver.sleep(500);

    await new Workbench().executeCommand(MANAGE_INTEGRATIONS);
    await driver.sleep(2500);

    // The integrations panel is a webview; poll until its body has rendered some text.
    const deadline = Date.now() + WEBVIEW_READ_TIMEOUT;
    let text = '';

    while (Date.now() < deadline) {
        const webview = new WebView();

        try {
            await webview.switchToFrame(6000);
            const body = await webview.findWebElement(By.css('body'));
            text = (await body.getText().catch(() => '')) || text;
        } catch (error) {
            console.warn('[integrations] switch/read webview:', error);
        } finally {
            await webview.switchBack().catch(() => undefined);
        }

        if (text.trim()) {
            return text;
        }

        await driver.sleep(1000);
    }

    return text;
}

describe('Deepnote — the integrations UI', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let screenshot: (label: string) => Promise<string>;

    before(async function () {
        screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(REVENUE_FILE);
        cleanupTempDir = copy.cleanup;
        fs.copyFileSync(
            path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', PLAIN_FILE),
            path.join(copy.tempDir, PLAIN_FILE)
        );

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[integrations] remove temp workspace dir during cleanup:', error);
        }
    });

    it('lists the project integration for a notebook that has one', async function () {
        const text = await openIntegrationsFor(REVENUE_FILE);
        await screenshot('integration-present');
        expect(text, 'integrations webview text').to.contain(INTEGRATION_NAME);
    });

    it('does not list that integration for a plain notebook', async function () {
        const text = await openIntegrationsFor(PLAIN_FILE);
        await screenshot('no-integration');
        // Positive signal that the panel actually rendered (a blank/failed read returns '', which
        // would make the `not.contain` below pass even if the integrations UI were broken).
        expect(text, 'integrations webview text').to.contain(NO_INTEGRATIONS_TEXT);
        expect(text, 'integrations webview text').to.not.contain(INTEGRATION_NAME);
    });
});
