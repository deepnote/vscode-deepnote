import { EditorView, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    ENV_CREATED_TIMEOUT,
    INTERPRETER_PROMPT_TIMEOUT,
    INTERPRETER_RETRY_DELAY,
    KERNEL_CONNECT_TIMEOUT,
    MAX_CREATE_ATTEMPTS,
    OPTIONAL_PROMPT_TIMEOUT,
    QUICK_PICK_TIMEOUT
} from './constants';
import { dismissAllNotifications, waitForNotification } from './notifications';
import { tryOpenInputBox } from './quickInput';

const CREATE_ENV_COMMAND = 'Deepnote: Create Environment';
const SELECT_ENV_COMMAND = 'Deepnote: Select Environment for Notebook';

/**
 * Drives `deepnote.environments.create`: pick interpreter -> name -> skip packages -> skip
 * description. Retries when interpreter discovery isn't ready yet, and treats "already exists" as
 * success so a leftover environment is reused.
 */
export async function createEnvironment(name: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
        await new Workbench().executeCommand(CREATE_ENV_COMMAND);

        // No interpreter discovered yet: the command shows a notification and returns instead.
        const interpreterPick = await tryOpenInputBox(INTERPRETER_PROMPT_TIMEOUT);
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
            await interpreterPick.cancel().catch((cancelError) => {
                console.warn('[deepnote-e2e] cancel interpreter quick pick:', cancelError);
            });
            await dismissAllNotifications();
            await driver.sleep(INTERPRETER_RETRY_DELAY);
            lastError = error;
            continue;
        }

        await interpreterPick.selectQuickPick(0);

        const nameBox = await InputBox.create();
        await nameBox.setText(name);
        await nameBox.confirm();

        // On an existing name the command short-circuits after the name prompt with no further
        // inputs, so only drive the optional prompts when the packages box actually appears.
        const packagesBox = await tryOpenInputBox(OPTIONAL_PROMPT_TIMEOUT);
        if (packagesBox) {
            await packagesBox.confirm();
            await (await InputBox.create()).confirm();
        }

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
 * Drives `deepnote.environments.selectForNotebook`, which rebuilds and selects the notebook's kernel
 * controller (provisioning the venv + toolkit) — the "wait for the kernel to connect" step.
 */
export async function selectEnvironmentForNotebook(name: string, notebookFileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    // The command requires an active `deepnote` notebook.
    await new EditorView().openEditor(notebookFileName);

    // Clear toasts that can overlap the quick pick and intercept clicks.
    await dismissAllNotifications();

    await new Workbench().executeCommand(SELECT_ENV_COMMAND);

    const environmentPick = await InputBox.create(QUICK_PICK_TIMEOUT);
    // Accept with Enter rather than clicking the row, whose description `<p>` can intercept a click.
    await environmentPick.setText(name);
    await driver.wait(
        async () => (await environmentPick.getQuickPicks()).length > 0,
        QUICK_PICK_TIMEOUT,
        'environment quick pick was empty'
    );
    await environmentPick.confirm();

    // Best-effort: the authoritative gate is the rendered output, so a missed toast must not fail.
    await waitForNotification(/switched successfully/i, KERNEL_CONNECT_TIMEOUT, false);
}
