/**
 * E2E (ExTester): "Add Existing Integration" links an integration ANOTHER project in the workspace
 * has stored credentials for into the current project — a link, not a copy: the credentials stay in
 * SecretStorage and only the project's integration list is rewritten.
 *
 * Candidates come from SecretStorage, which nothing outside the UI can seed, so the suite configures
 * a PostgreSQL integration in one project through the integrations panel and reuses it from the
 * other. Runs without a Python kernel.
 */

import { deserializeDeepnoteFile } from '@deepnote/blocks';
import { expect } from 'chai';
import * as fs from 'fs';
import { By, EditorView, InputBox, QuickPickItem, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    assertNotNull,
    copyFixtureIntoDir,
    copyFixtureToTempDir,
    createScreenshotter,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    waitForNotification
} from '../../helpers';

/** Where the shared integration is configured. Its project declares none of its own to begin with. */
const SOURCE_FILE = 'quick-notes.deepnote';
const SOURCE_PROJECT_NAME = 'Quick Notes';
/** Where it is reused. Its project already declares an integration, which the link must not drop. */
const TARGET_FILE = 'sales-analytics-revenue.deepnote';
const TARGET_OWN_INTEGRATION = { id: 'int-bq-sales', name: 'Sales BigQuery', type: 'big-query' };

const INTEGRATION_NAME = 'E2E Shared Postgres';
const INTEGRATION_TYPE_LABEL = 'PostgreSQL';
const INTEGRATION_HOST = 'e2e-postgres.invalid';
const INTEGRATION_DATABASE = 'e2e_reuse_db';
const INTEGRATION_USER = 'e2e_reuse_user';
const INTEGRATION_PASSWORD = 'e2e-reuse-password';

const MANAGE_INTEGRATIONS = 'Deepnote: Manage Integrations';
const ADD_EXISTING_INTEGRATION = 'Deepnote: Add Existing Integration';
const PICKER_PLACEHOLDER = 'Select an integration configured in another project of this workspace';

// Prior editors finish closing before the next notebook opens.
const EDITORS_CLOSE_DELAY = 500;
// Freshly opened notebook paints before we refocus it.
const NOTEBOOK_OPEN_SETTLE_DELAY = 1_500;
// Notebook editor becomes active so the command targets it.
const EDITOR_REFOCUS_DELAY = 500;
// The integrations panel opens and its React app renders.
const PANEL_RENDER_TIMEOUT = 45_000;
// Attach to the panel's webview frame per attempt.
const WEBVIEW_FRAME_SWITCH_TIMEOUT = 6_000;
// Pause between attach attempts.
const WEBVIEW_POLL_INTERVAL = 1_000;
// Saving writes SecretStorage and every `.deepnote` file of the project; poll the file for the result.
const FILE_WRITE_TIMEOUT = 30_000;
const FILE_POLL_INTERVAL = 500;

type DeclaredIntegration = { id: string; name?: string; type: string };

function readDeclaredIntegrations(filePath: string): DeclaredIntegration[] {
    return deserializeDeepnoteFile(fs.readFileSync(filePath, 'utf8')).project.integrations ?? [];
}

/** Closes every editor and makes `fileName` the active one — both commands act on the active notebook. */
async function focusNotebook(fileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    // The integrations panel is an editor too, and it would otherwise still be the active one.
    await new EditorView().closeAllEditors().catch((error) => {
        console.warn('[add-existing] close editors:', error);
    });
    await driver.sleep(EDITORS_CLOSE_DELAY);

    await openWorkspaceFile(fileName);
    await driver.sleep(NOTEBOOK_OPEN_SETTLE_DELAY);
    await new EditorView().openEditor(fileName).catch((error) => {
        console.warn(`[add-existing] refocus ${fileName}:`, error);
    });
    await driver.sleep(EDITOR_REFOCUS_DELAY);
}

/** Polls until the integrations panel has rendered, leaving the driver outside the webview frame. */
async function awaitIntegrationsPanel(): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + PANEL_RENDER_TIMEOUT;
    let lastError: unknown;

    while (Date.now() < deadline) {
        const webview = new WebView();

        try {
            await webview.switchToFrame(WEBVIEW_FRAME_SWITCH_TIMEOUT);

            if ((await driver.findElements(By.css('.integration-type-selector'))).length > 0) {
                return;
            }
        } catch (error) {
            lastError = error;
        } finally {
            await webview.switchBack().catch((error) => {
                console.warn('[add-existing] switch back while waiting for the panel:', error);
            });
        }

        await driver.sleep(WEBVIEW_POLL_INTERVAL);
    }

    throw new Error(`The integrations panel did not render within ${PANEL_RENDER_TIMEOUT}ms: ${lastError}`);
}

/** Runs `act` inside the integrations panel's webview frame. */
async function inIntegrationsPanel<T>(act: () => Promise<T>): Promise<T> {
    const webview = new WebView();
    await webview.switchToFrame(WEBVIEW_FRAME_SWITCH_TIMEOUT);

    try {
        return await act();
    } finally {
        await webview.switchBack().catch((error) => {
            console.warn('[add-existing] switch back from the panel:', error);
        });
    }
}

/**
 * Fills in and saves a new PostgreSQL integration in the panel of the currently open project, which
 * is what puts its credentials in SecretStorage and declares it on that project.
 */
async function configurePostgresIntegration(): Promise<void> {
    const driver = VSBrowser.instance.driver;

    await focusNotebook(SOURCE_FILE);
    await new Workbench().executeCommand(MANAGE_INTEGRATIONS);
    await awaitIntegrationsPanel();

    await inIntegrationsPanel(async () => {
        // Locate AND click in one wait: the grid re-renders as the panel receives its first update.
        await driver.wait(
            async () => {
                for (const card of await driver.findElements(By.css('.integration-type-card'))) {
                    if (!(await card.getText()).includes(INTEGRATION_TYPE_LABEL)) {
                        continue;
                    }

                    await card.click();

                    return true;
                }

                return false;
            },
            PANEL_RENDER_TIMEOUT,
            `the "${INTEGRATION_TYPE_LABEL}" integration type card could not be clicked`
        );

        await driver.wait(
            async () => (await driver.findElements(By.css('.configuration-form-container #password'))).length > 0,
            PANEL_RENDER_TIMEOUT,
            'the PostgreSQL configuration form did not open'
        );

        // Port keeps its 5432 default; the rest are required and start empty except the generated name.
        for (const [selector, value] of [
            ['#name', INTEGRATION_NAME],
            ['#host', INTEGRATION_HOST],
            ['#database', INTEGRATION_DATABASE],
            ['#username', INTEGRATION_USER],
            ['#password', INTEGRATION_PASSWORD]
        ]) {
            const field = await driver.findElement(By.css(`.configuration-form-container ${selector}`));
            await field.clear();
            await field.sendKeys(value);
        }

        await driver.findElement(By.css('.configuration-form-container .form-actions button.primary')).click();
    });
}

/** Polls `filePath` until its project declares an integration named `name`, and returns that entry's id. */
async function awaitDeclaredIntegrationId(filePath: string, name: string): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + FILE_WRITE_TIMEOUT;
    let declared: DeclaredIntegration[] = [];

    while (Date.now() < deadline) {
        declared = readDeclaredIntegrations(filePath);

        const match = declared.find((entry) => entry.name === name);

        if (match) {
            return match.id;
        }

        await driver.sleep(FILE_POLL_INTERVAL);
    }

    throw new Error(
        `${filePath} never declared an integration named "${name}" within ${FILE_WRITE_TIMEOUT}ms; ` +
            `last saw ${JSON.stringify(declared)}`
    );
}

describe('Deepnote — adding an integration another project already configured', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let noneAvailableToastShown = false;
    let pickedDescription: string | undefined;
    let pickedLabel = '';
    let pickedRowText = '';
    let sharedIntegrationId = '';
    let successToastShown = false;
    let targetFileContents = '';
    let targetIntegrations: DeclaredIntegration[] = [];

    before(async function () {
        const screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(SOURCE_FILE);
        cleanupTempDir = copy.cleanup;
        const sourceFilePath = copy.filePath;
        const targetFilePath = copyFixtureIntoDir(copy.tempDir, TARGET_FILE);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Nothing is reusable yet: the other project declares "Sales BigQuery" but has never stored
        // credentials for it, and a declaration on its own carries nothing to reuse.
        await focusNotebook(SOURCE_FILE);
        await new Workbench().executeCommand(ADD_EXISTING_INTEGRATION);
        noneAvailableToastShown =
            (await waitForNotification(
                /No integrations from other projects in this workspace are available to add/i,
                WORKBENCH_TIMEOUT,
                true
            )) !== undefined;
        await screenshot('nothing-to-reuse');
        await dismissAllNotifications();

        await configurePostgresIntegration();
        sharedIntegrationId = await awaitDeclaredIntegrationId(sourceFilePath, INTEGRATION_NAME);
        await screenshot('configured-in-the-other-project');
        await dismissAllNotifications();

        await focusNotebook(TARGET_FILE);
        await new Workbench().executeCommand(ADD_EXISTING_INTEGRATION);

        const picker = await InputBox.create(QUICK_PICK_TIMEOUT);
        let picked: QuickPickItem | undefined;

        // The command palette reuses this widget, so gate on OUR placeholder before reading the items.
        await VSBrowser.instance.driver.wait(
            async () => {
                if ((await picker.getPlaceHolder().catch(() => '')) !== PICKER_PLACEHOLDER) {
                    return false;
                }

                for (const candidate of await picker.getQuickPicks()) {
                    if ((await candidate.getLabel()) !== INTEGRATION_NAME) {
                        continue;
                    }

                    picked = candidate;

                    return true;
                }

                return false;
            },
            QUICK_PICK_TIMEOUT,
            `the reuse picker never offered "${INTEGRATION_NAME}"`
        );
        await screenshot('reuse-picker');

        const item = assertNotNull(picked, `the reuse picker never offered "${INTEGRATION_NAME}"`);

        pickedLabel = await item.getLabel();
        pickedDescription = await item.getDescription();
        // The detail line ("Used in: …") has no page object; it is part of the row's rendered text.
        pickedRowText = await item.getText();
        await item.select();

        successToastShown =
            (await waitForNotification(
                new RegExp(`Added integration "${INTEGRATION_NAME}" to this project`),
                WORKBENCH_TIMEOUT,
                true
            )) !== undefined;
        await screenshot('linked-into-this-project');

        targetIntegrations = readDeclaredIntegrations(targetFilePath);
        targetFileContents = fs.readFileSync(targetFilePath, 'utf8');
    });

    after(async function () {
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[add-existing] remove temp workspace dir during cleanup:', error);
        }
    });

    // Deliberately one test: every expectation reads state the `before` hook already captured, so
    // splitting them buys separate mocha records and nothing else.
    it('offers only what the other project configured, and links it without its credentials', function () {
        // offers nothing while the other project has only declared an integration, never configured it
        expect(noneAvailableToastShown, '"nothing to reuse" notification').to.equal(true);

        // offers the integration the other project configured, and names that project
        expect(pickedLabel, 'quick pick label').to.equal(INTEGRATION_NAME);
        expect(pickedDescription, 'quick pick description').to.equal(INTEGRATION_TYPE_LABEL);
        expect(pickedRowText, 'quick pick row').to.contain(`Used in: ${SOURCE_PROJECT_NAME}`);

        // confirms the link with a toast
        expect(successToastShown, 'integration-added toast').to.equal(true);

        // writes the link into this project on disk, keeping the integration it already had
        expect(targetIntegrations, 'integrations declared by the target project').to.deep.equal([
            TARGET_OWN_INTEGRATION,
            { id: sharedIntegrationId, name: INTEGRATION_NAME, type: 'pgsql' }
        ]);

        // links the integration without copying its credentials into the file
        expect(targetFileContents, 'target project file').to.not.contain(INTEGRATION_HOST);
        expect(targetFileContents, 'target project file').to.not.contain(INTEGRATION_PASSWORD);
    });
});
