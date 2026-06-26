import { EditorView, InputBox, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    ENV_CREATED_TIMEOUT,
    INTERPRETER_RETRY_DELAY,
    KERNEL_CONNECT_TIMEOUT,
    MAX_CREATE_ATTEMPTS,
    OPTIONAL_PROMPT_TIMEOUT,
    QUICK_PICK_TIMEOUT
} from './constants';
import { dismissAllNotifications, waitForNotification } from './notifications';
import { tryOpenInputBox } from './quickInput';

// Command palette labels (category + title) the way `Workbench.executeCommand` matches them.
const CREATE_ENV_COMMAND = 'Deepnote: Create Environment';
const SELECT_ENV_COMMAND = 'Deepnote: Select Environment for Notebook';

/**
 * Drives `deepnote.environments.create`: pick interpreter -> name -> skip packages -> skip
 * description. Retries when the Python extension has not finished discovering an interpreter yet
 * (the command shows an error and returns instead of opening a quick pick). Idempotent — the
 * "already exists" guard is treated as success so a leftover environment from a previous/retried run
 * is reused rather than colliding.
 */
export async function createEnvironment(name: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
        await new Workbench().executeCommand(CREATE_ENV_COMMAND);

        // Either the interpreter quick pick opens, or (no interpreter discovered yet) the command
        // shows a "No Python interpreters found" notification and returns.
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

        // On an existing name the create command short-circuits after the name prompt with an
        // "already exists" notification and opens no further inputs, so only drive the optional
        // prompts when the packages box actually appears. This keeps the documented idempotent
        // retry path working: a leftover environment is reused rather than failing the test on a
        // timed-out InputBox that never opens.
        const packagesBox = await tryOpenInputBox(OPTIONAL_PROMPT_TIMEOUT);
        if (packagesBox) {
            // Packages (optional) — leave empty.
            await packagesBox.confirm();

            // Description (optional) — leave empty.
            await (await InputBox.create()).confirm();
        }

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
 * explicitly selects the notebook's kernel controller (provisioning the venv + toolkit), which is
 * what "wait for the kernel to connect" means in this extension.
 */
export async function selectEnvironmentForNotebook(name: string, notebookFileName: string): Promise<void> {
    const driver = VSBrowser.instance.driver;

    // The command requires an active `deepnote` notebook — make sure it's focused.
    await new EditorView().openEditor(notebookFileName);

    // Clear the "select an environment" prompt and any other toasts; they can overlap the quick pick
    // and intercept clicks.
    await dismissAllNotifications();

    await new Workbench().executeCommand(SELECT_ENV_COMMAND);

    const environmentPick = await InputBox.create(QUICK_PICK_TIMEOUT);
    // Filter to the environment by name and accept with Enter rather than clicking the row: the
    // quick-pick row contains a description `<p>` that can intercept a positional click.
    await environmentPick.setText(name);
    await driver.wait(
        async () => (await environmentPick.getQuickPicks()).length > 0,
        QUICK_PICK_TIMEOUT,
        'environment quick pick was empty'
    );
    await environmentPick.confirm();

    // Best-effort wait for the "switched successfully" toast; the authoritative gate is the rendered
    // output, so a missed (auto-dismissed) toast must not fail the test.
    await waitForNotification(/switched successfully/i, KERNEL_CONNECT_TIMEOUT, false);
}
