/**
 * End-to-end UI test driven by ExTester (vscode-extension-tester).
 *
 * It exercises the full Deepnote happy path through the *real* VS Code UI:
 *   1. open a one-notebook `.deepnote` file containing `print("hello world")`
 *   2. create a Deepnote environment            (command `deepnote.environments.create`)
 *   3. select that environment for the notebook (command `deepnote.environments.selectForNotebook`)
 *      — this builds and selects the notebook's kernel controller ("kernel connected")
 *   4. run the cell                             (the notebook toolbar's "Run All" button)
 *   5. assert the rendered stdout output contains "hello world"
 *
 * Prerequisites (see specs/e2e-extester-testing-plan.md):
 *   - The Python extension (`ms-python.python`) must be installed in the test instance
 *     (`npm run setup:e2e:deps`) and at least one Python interpreter must be discoverable.
 *   - Creating the environment provisions a venv and the Deepnote toolkit, which needs
 *     network access; the first kernel start can take a few minutes.
 *
 * Notebook output in VS Code renders inside two nested iframes
 * (iframe.webview.ready -> #active-frame). ExTester's WebView page object descends
 * exactly those two levels, which is how we read the rendered output below.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { expect } from 'chai';
import {
    By,
    EditorView,
    InputBox,
    Notification,
    VSBrowser,
    WebView,
    Workbench,
    type WebDriver
} from 'vscode-extension-tester';

// Command palette labels (category + title) the way `Workbench.executeCommand` matches them.
const CREATE_ENV_COMMAND = 'Deepnote: Create Environment';
const SELECT_ENV_COMMAND = 'Deepnote: Select Environment for Notebook';

const NOTEBOOK_FILE_NAME = 'hello-world.deepnote';
const EXPECTED_OUTPUT = 'hello world';

// Timeouts (ms). UI ops are slow and the first kernel start is the slowest step.
const WORKBENCH_TIMEOUT = 60_000;
const QUICK_PICK_TIMEOUT = 30_000;
const ENV_CREATED_TIMEOUT = 120_000;
const KERNEL_CONNECT_TIMEOUT = 300_000;
const OUTPUT_TIMEOUT = 300_000;
// How often to re-issue "Run All" while waiting for output — the first run can be dropped right
// after the kernel connects.
const RUN_ALL_REISSUE_INTERVAL = 25_000;
const INTERPRETER_RETRY_DELAY = 5_000;
const MAX_CREATE_ATTEMPTS = 6;
// The in-window simple file/folder dialog needs a beat to resolve a typed path before it accepts.
const DIALOG_RESOLVE_DELAY = 1_500;
const FOLDER_OPEN_ATTEMPTS = 5;
const FOLDER_RELOAD_TIMEOUT = 12_000;

// Selectors that only exist inside the notebook output iframe (`#active-frame`),
// so reading them cannot accidentally match the cell's source in the editor.
const OUTPUT_SELECTOR = '.output_container, .output, .rendered-output';

describe('Deepnote E2E — run "hello world"', function () {
    // Per-test timeout for the whole suite (overrides the mocharc default for these tests).
    this.timeout(22 * 60 * 1000);

    let driver: WebDriver;
    let notebookFile: string;
    // A stable name: createEnvironment is idempotent (it treats "already exists" as success), so a
    // leftover environment from a previous or retried run is reused rather than colliding — which
    // also lets a persistent test instance reuse the already-provisioned venv.
    const environmentName = 'E2E Hello Env';

    before(async function () {
        driver = VSBrowser.instance.driver;

        // Open a throwaway copy so execution-dirtied notebook state never touches the source tree.
        const source = path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', NOTEBOOK_FILE_NAME);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-e2e-'));
        notebookFile = path.join(tempDir, NOTEBOOK_FILE_NAME);
        fs.copyFileSync(source, notebookFile);

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the temp directory as a workspace folder FIRST. The Deepnote serializer reads a
        // "snapshot" during deserialization and, with no workspace folder open, blocks on a
        // `showWarningMessage('Cannot read snapshot: No workspace folders found.')` that never
        // resolves headlessly — leaving the notebook blank. A workspace folder also provides the
        // requirements.txt path the kernel auto-selector needs. (Opening a folder reloads the
        // window, so we re-wait for the workbench afterwards.)
        await openFolderViaDialog(tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // Open the notebook by driving the running window directly. ExTester's `openResources`
        // shells out to `code -r <file>` (reuse-window over IPC), which silently no-ops in a
        // sandboxed/headless environment. Now that the containing folder is the workspace, the
        // notebook is reachable by name through Quick Open ("Go to File...").
        await openWorkspaceFile(NOTEBOOK_FILE_NAME);

        // The native notebook editor opens because the extension registers a serializer for
        // the `deepnote` notebook type; a single-notebook file resolves to its default notebook.
        await driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((t) => t.includes(NOTEBOOK_FILE_NAME)),
            WORKBENCH_TIMEOUT,
            'Deepnote notebook editor did not open'
        );
    });

    after(async function () {
        // Defensive cleanup: never leave the driver stuck inside a webview frame, and close tabs.
        await new WebView().switchBack().catch(() => undefined);
        await new EditorView().closeAllEditors().catch(() => undefined);
    });

    it('creates an environment, connects the kernel, runs the cell and renders output', async function () {
        await createEnvironment(environmentName);
        await selectEnvironmentForNotebook(environmentName);

        const renderedOutput = await runAndAwaitOutput(EXPECTED_OUTPUT, OUTPUT_TIMEOUT);
        expect(renderedOutput).to.contain(EXPECTED_OUTPUT);
    });

    /**
     * Drives `deepnote.environments.create`: pick interpreter -> name -> skip packages ->
     * skip description. Retries when the Python extension has not finished discovering an
     * interpreter yet (the command shows an error and returns instead of opening a quick pick).
     */
    async function createEnvironment(name: string): Promise<void> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
            await new Workbench().executeCommand(CREATE_ENV_COMMAND);

            // Either the interpreter quick pick opens, or (no interpreter discovered yet) the
            // command shows a "No Python interpreters found" notification and returns.
            const interpreterPick = await tryOpenInputBox(5_000);
            if (!interpreterPick) {
                await dismissAllNotifications();
                await driver.sleep(INTERPRETER_RETRY_DELAY);
                lastError = new Error('interpreter quick pick did not appear (interpreter discovery not ready?)');
                continue;
            }

            try {
                await driver.wait(
                    async () => (await interpreterPick.getQuickPicks()).length > 0,
                    QUICK_PICK_TIMEOUT,
                    'no Python interpreters were listed'
                );
            } catch (error) {
                await interpreterPick.cancel().catch(() => undefined);
                await dismissAllNotifications();
                await driver.sleep(INTERPRETER_RETRY_DELAY);
                lastError = error;
                continue;
            }

            await interpreterPick.selectQuickPick(0);

            const nameBox = await InputBox.create();
            await nameBox.setText(name);
            await nameBox.confirm();

            // Packages (optional) — leave empty.
            await (await InputBox.create()).confirm();

            // Description (optional) — leave empty.
            await (await InputBox.create()).confirm();

            // Treat both the success toast and the "already exists" guard as success: a leftover
            // environment from a previous/retried run is fine — it will be selected next.
            await waitForNotification(/created successfully|already exists/i, ENV_CREATED_TIMEOUT, false);
            return;
        }

        throw new Error(
            `Failed to create a Deepnote environment after ${MAX_CREATE_ATTEMPTS} attempts. ` +
                `Ensure the Python extension is installed and an interpreter is discoverable. ` +
                `Last error: ${String(lastError)}`
        );
    }

    /**
     * Drives `deepnote.environments.selectForNotebook`. Selecting the environment rebuilds and
     * explicitly selects the notebook's kernel controller (provisioning the venv + toolkit),
     * which is what "wait for the kernel to connect" means in this extension.
     */
    async function selectEnvironmentForNotebook(name: string): Promise<void> {
        // The command requires an active `deepnote` notebook — make sure it's focused.
        await new EditorView().openEditor(NOTEBOOK_FILE_NAME);

        // Clear the "select an environment" prompt and any other toasts; they can overlap the
        // quick pick and intercept clicks.
        await dismissAllNotifications();

        await new Workbench().executeCommand(SELECT_ENV_COMMAND);

        const environmentPick = await InputBox.create(QUICK_PICK_TIMEOUT);
        // Filter to the environment by name and accept with Enter rather than clicking the row:
        // the quick-pick row contains a description `<p>` that can intercept a positional click.
        await environmentPick.setText(name);
        await driver.wait(
            async () => (await environmentPick.getQuickPicks()).length > 0,
            QUICK_PICK_TIMEOUT,
            'environment quick pick was empty'
        );
        await environmentPick.confirm();

        // Best-effort wait for the "switched successfully" toast; the authoritative gate is the
        // rendered output below, so a missed (auto-dismissed) toast must not fail the test.
        await waitForNotification(/switched successfully/i, KERNEL_CONNECT_TIMEOUT, false);
    }

    /**
     * Clicks the notebook editor toolbar's "Run All" button. The command-palette entry for
     * `deepnote.runallcells` ("Jupyter: Run All Cells") is gated behind context keys
     * (`deepnote.ispythonornativeactive`, …) that are not reliably set under automation, so driving
     * it through `Workbench.executeCommand` can silently miss and trigger the wrong command.
     */
    async function clickRunAll(): Promise<void> {
        await new EditorView().openEditor(NOTEBOOK_FILE_NAME);

        const runAllButton = await driver.wait(
            async () => {
                const [button] = await driver.findElements(By.css('a.action-label[aria-label="Run All"]'));

                return button;
            },
            WORKBENCH_TIMEOUT,
            'notebook "Run All" button did not appear'
        );
        await runAllButton.click();
    }

    /**
     * Opens a file that lives in the currently-open workspace folder via Quick Open ("Go to
     * File..."), matching by file name. Unlike the simple Open File dialog (where Enter does not
     * accept a typed path), Quick Open reliably opens the highlighted match on confirm.
     */
    async function openWorkspaceFile(fileName: string): Promise<void> {
        await new Workbench().executeCommand('Go to File...');

        const quickOpen = await InputBox.create(QUICK_PICK_TIMEOUT);
        await quickOpen.setText(fileName);
        await driver.wait(
            async () => (await quickOpen.getQuickPicks()).length > 0,
            QUICK_PICK_TIMEOUT,
            `"${fileName}" did not appear in Quick Open`
        );
        await quickOpen.confirm();
    }

    /**
     * Opens an absolute folder path as the workspace root via "File: Open Folder...". Opening a
     * folder reloads the VS Code window. In the simple folder dialog, Enter navigates *into* a
     * directory rather than accepting it as the workspace — the deterministic accept is the dialog's
     * "OK" button — so we type the path, click OK, and wait for the pre-reload workbench element to
     * detach (reload started). We retry the whole interaction defensively. The caller then waits for
     * the new workbench to mount.
     */
    async function openFolderViaDialog(folder: string): Promise<void> {
        for (let attempt = 1; attempt <= FOLDER_OPEN_ATTEMPTS; attempt++) {
            const previousWorkbench = await driver.findElement(By.css('.monaco-workbench'));

            await new Workbench().executeCommand('File: Open Folder...');
            const dialog = await InputBox.create(QUICK_PICK_TIMEOUT);
            await dialog.setText(folder);

            // The simple dialog resolves the typed path asynchronously (listing the enclosing
            // directory); wait for that listing and add a short settle before accepting.
            await driver
                .wait(
                    async () => (await dialog.getQuickPicks()).length > 0,
                    QUICK_PICK_TIMEOUT,
                    'dialog did not resolve path'
                )
                .catch(() => undefined);
            await driver.sleep(DIALOG_RESOLVE_DELAY);

            const accepted = await clickDialogOkButton();
            if (!accepted) {
                await new InputBox().cancel().catch(() => undefined);
                continue;
            }

            const reloaded = await driver
                .wait(async () => {
                    try {
                        await previousWorkbench.getTagName();

                        return false;
                    } catch {
                        return true;
                    }
                }, FOLDER_RELOAD_TIMEOUT)
                .then(() => true)
                .catch(() => false);
            if (reloaded) {
                return;
            }

            // The folder did not open this time; dismiss any lingering dialog and retry.
            await new InputBox().cancel().catch(() => undefined);
        }

        throw new Error(`Failed to open folder "${folder}" after ${FOLDER_OPEN_ATTEMPTS} attempts`);
    }

    /** Clicks the simple file/folder dialog's "OK" button. Returns false if it could not be found. */
    async function clickDialogOkButton(): Promise<boolean> {
        const buttons = await driver
            .findElements(By.css('.quick-input-widget .monaco-button.monaco-text-button'))
            .catch(() => []);
        for (const button of buttons) {
            const text = (await button.getText().catch(() => '')).trim();
            if (text === 'OK') {
                await button.click();

                return true;
            }
        }

        return false;
    }

    /**
     * Clicks "Run All" and polls the notebook output webview until the expected text renders,
     * re-issuing "Run All" periodically. The first run can be dropped when the kernel has only just
     * finished connecting, so we keep nudging it until output appears (re-running `print(...)` is
     * harmless).
     */
    async function runAndAwaitOutput(expected: string, timeout: number): Promise<string> {
        const deadline = Date.now() + timeout;
        let lastRunAt = 0;
        let lastText = '';

        while (Date.now() < deadline) {
            if (Date.now() - lastRunAt > RUN_ALL_REISSUE_INTERVAL) {
                await clickRunAll().catch(() => undefined);
                lastRunAt = Date.now();
            }

            lastText = await readRenderedOutput();
            if (lastText.includes(expected)) {
                return lastText;
            }

            await driver.sleep(2_000);
        }

        throw new Error(
            `Timed out after ${timeout}ms waiting for rendered output to contain "${expected}". ` +
                `Last observed output: ${JSON.stringify(lastText)}`
        );
    }

    /**
     * Reads the notebook cell output once.
     *
     * Output lives two iframes deep (iframe.webview.ready -> #active-frame). We only attempt to
     * switch when an output webview iframe actually exists (`getViewToSwitchTo`), and we read
     * output-specific elements inside the frame — so we never match the cell's source code that
     * is visible in the editor of the main document. Returns '' when no output is present yet.
     */
    async function readRenderedOutput(): Promise<string> {
        const webView = new WebView();
        const outputFrame = await webView.getViewToSwitchTo().catch(() => undefined);
        if (!outputFrame) {
            return '';
        }

        let text = '';
        try {
            await webView.switchToFrame(5_000);
            const elements = await webView.findWebElements(By.css(OUTPUT_SELECTOR));
            const texts = await Promise.all(elements.map((element) => element.getText().catch(() => '')));
            text = texts.join('\n').trim();

            // Fallback: if the renderer used unexpected classes, read the frame body — safe here
            // because we have confirmed we are inside the output iframe, not the editor.
            if (!text) {
                const body = await webView.findWebElement(By.css('body')).catch(() => undefined);
                text = body ? (await body.getText().catch(() => '')).trim() : '';
            }
        } catch {
            // Frame went stale or output not painted yet — treat as no output this tick.
        } finally {
            await webView.switchBack().catch(() => undefined);
        }

        return text;
    }

    async function tryOpenInputBox(timeout: number): Promise<InputBox | undefined> {
        try {
            return await InputBox.create(timeout);
        } catch {
            return undefined;
        }
    }

    async function dismissAllNotifications(): Promise<void> {
        const notifications = await new Workbench().getNotifications().catch(() => [] as Notification[]);
        for (const notification of notifications) {
            await notification.dismiss().catch(() => undefined);
        }
    }

    async function waitForNotification(
        pattern: RegExp,
        timeout: number,
        required: boolean
    ): Promise<Notification | undefined> {
        try {
            return (await driver.wait(
                async () => {
                    const notifications = await new Workbench().getNotifications().catch(() => [] as Notification[]);
                    for (const notification of notifications) {
                        const message = await notification.getMessage().catch(() => '');
                        if (pattern.test(message)) {
                            return notification;
                        }
                    }
                    return undefined;
                },
                timeout,
                `timed out waiting for a notification matching ${pattern}`
            )) as Notification;
        } catch (error) {
            if (required) {
                throw error;
            }
            return undefined;
        }
    }
});
