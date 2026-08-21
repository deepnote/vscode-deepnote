/**
 * E2E (ExTester): "Manage Integrations" lists a project's integration for a notebook whose project
 * declares one, and shows the empty state for a plain notebook. Runs without a Python kernel.
 */

import { expect } from 'chai';
import { By, EditorView, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    copyFixtureIntoDir,
    copyFixtureToTempDir,
    createScreenshotter,
    enterFixturesWorkspace,
    openWorkspaceFile
} from '../../helpers';

const REVENUE_FILE = 'sales-analytics-revenue.deepnote';
const PLAIN_FILE = 'quick-notes.deepnote';
const INTEGRATION_NAME = 'Sales BigQuery';
const MANAGE_INTEGRATIONS = 'Deepnote: Manage Integrations';
const WEBVIEW_READ_TIMEOUT = 15_000;
// Empty-state text asserted to prove the panel actually opened (else the negative `not.contain`
// below passes trivially against a blank/failed `''` read).
const NO_INTEGRATIONS_TEXT = 'No integrations found in this project.';
// Prior editors finish closing before reopening the target notebook.
const EDITORS_CLOSE_DELAY = 500;
// Freshly opened notebook paints before we refocus it.
const NOTEBOOK_OPEN_SETTLE_DELAY = 1_500;
// Notebook editor becomes active so the command targets it.
const EDITOR_REFOCUS_DELAY = 500;
// Integrations panel opens before we read its webview.
const PANEL_OPEN_DELAY = 2_500;
// Attach to the webview frame per read attempt.
const WEBVIEW_FRAME_SWITCH_TIMEOUT = 6_000;
// Pause between webview read attempts.
const WEBVIEW_POLL_INTERVAL = 1_000;

/** Opens a notebook, runs "Manage Integrations", and returns the integrations webview's text. */
async function openIntegrationsFor(fileName: string): Promise<string> {
    const driver = VSBrowser.instance.driver;

    // The integrations panel is reused, so close prior editors: "Manage Integrations" needs the
    // target notebook to be the active editor, not the still-open panel.
    await new EditorView().closeAllEditors().catch(() => undefined);
    await driver.sleep(EDITORS_CLOSE_DELAY);

    await openWorkspaceFile(fileName);
    await driver.wait(
        async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(fileName)),
        WORKBENCH_TIMEOUT,
        `${fileName} did not open`
    );
    await driver.sleep(NOTEBOOK_OPEN_SETTLE_DELAY);
    await new EditorView().openEditor(fileName).catch(() => undefined);
    await driver.sleep(EDITOR_REFOCUS_DELAY);

    await new Workbench().executeCommand(MANAGE_INTEGRATIONS);
    await driver.sleep(PANEL_OPEN_DELAY);

    // Poll the webview body until it has rendered some text.
    const deadline = Date.now() + WEBVIEW_READ_TIMEOUT;
    let text = '';

    while (Date.now() < deadline) {
        const webview = new WebView();

        try {
            await webview.switchToFrame(WEBVIEW_FRAME_SWITCH_TIMEOUT);
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

        await driver.sleep(WEBVIEW_POLL_INTERVAL);
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
        copyFixtureIntoDir(copy.tempDir, PLAIN_FILE);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await enterFixturesWorkspace();
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
        // Positive signal that the panel rendered (a blank read would make `not.contain` pass trivially).
        expect(text, 'integrations webview text').to.contain(NO_INTEGRATIONS_TEXT);
        expect(text, 'integrations webview text').to.not.contain(INTEGRATION_NAME);
    });
});
