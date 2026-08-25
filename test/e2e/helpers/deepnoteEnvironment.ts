import { EditorView, InputBox, QuickPickItem, VSBrowser, Workbench } from 'vscode-extension-tester';

import {
    ANY_VENV_MARKER,
    ENV_CREATED_TIMEOUT,
    INTERPRETER_PROMPT_TIMEOUT,
    INTERPRETER_RETRY_DELAY,
    KERNEL_CONNECT_TIMEOUT,
    MAX_CREATE_ATTEMPTS,
    OPTIONAL_PROMPT_TIMEOUT,
    PREBAKED_VENV_DIR_NAME,
    PREBAKED_VENV_FILTER_TIMEOUT,
    QUICK_PICK_TIMEOUT
} from './constants';
import { dismissAllNotifications, waitForNotification } from './notifications';
import { tryOpenInputBox } from './quickInput';

// Command palette labels (category + title) the way `Workbench.executeCommand` matches them.
const CREATE_ENV_COMMAND = 'Deepnote: Create Environment';
const SELECT_ENV_COMMAND = 'Deepnote: Select Environment for Notebook';

/**
 * Reads a quick-pick row as the label to filter by plus the label-and-description text to match
 * against: the Python extension puts the interpreter path in either field depending on the entry,
 * so matching one alone misses venvs described in the other.
 */
async function readPick(pick: QuickPickItem): Promise<{ label: string; text: string }> {
    const label = await pick.getLabel();

    return { label, text: `${label} ${(await pick.getDescription()) ?? ''}` };
}

/**
 * Picks the managed venv, which the extension adopts instead of provisioning its own.
 *
 * `useManagedVenv` picks an interpreter outside it, so the extension creates and owns the venv —
 * only the deletion suite needs that, since deleteEnvironment removes the directory for managed
 * environments only.
 */
async function selectInterpreter(interpreterPick: InputBox, useManagedVenv: boolean): Promise<void> {
    const driver = VSBrowser.instance.driver;

    if (!useManagedVenv) {
        await interpreterPick.setText(PREBAKED_VENV_DIR_NAME);
        // Wait for the *top row* to be the baked venv, not merely for the list to be non-empty:
        // VS Code applies the filter asynchronously, so the stale unfiltered list is briefly still
        // there and confirming against it would pick an arbitrary interpreter.
        const filtered = await driver
            .wait(async () => {
                const picks = await interpreterPick.getQuickPicks();
                if (picks.length === 0) {
                    return undefined;
                }
                const first = await readPick(picks[0]);

                return first.text.includes(PREBAKED_VENV_DIR_NAME) ? picks[0] : undefined;
            }, PREBAKED_VENV_FILTER_TIMEOUT)
            .catch(() => undefined);

        if (filtered) {
            await interpreterPick.confirm();

            return;
        }

        console.warn(
            `[deepnote-e2e] no interpreter under ${PREBAKED_VENV_DIR_NAME} was offered; falling back to ` +
                'the first entry. The run will provision a venv and take several minutes longer — ' +
                'check that `npm run setup:e2e:venv` ran.'
        );
        await interpreterPick.setText('');
    }

    const picks = await interpreterPick.getQuickPicks();
    const entries = await Promise.all(picks.map(readPick));
    // Any venv, not just the baked one: the extension adopts whatever venv it is pointed at
    // (managedVenv: false), leaving the deletion suite nothing to delete. In CI this resolves to the
    // interpreter actions/setup-python installed.
    const wanted = entries.find((entry) => !entry.text.includes(ANY_VENV_MARKER))?.label;

    if (wanted) {
        // Filter to it and accept with Enter, the same way the baked-venv branch does, rather than
        // clicking a row or walking the list: rows intercept positional clicks, and an arrow-key walk
        // silently lands on the wrong entry whenever the list scrolls or reorders under it.
        await interpreterPick.setText(wanted);
        const narrowed = await driver
            .wait(async () => {
                const filtered = await interpreterPick.getQuickPicks();
                if (filtered.length === 0) {
                    return false;
                }

                return !(await readPick(filtered[0])).text.includes(ANY_VENV_MARKER);
            }, PREBAKED_VENV_FILTER_TIMEOUT)
            .catch(() => false);

        if (narrowed) {
            await interpreterPick.confirm();

            return;
        }

        await interpreterPick.setText('');
    }

    console.warn(
        '[deepnote-e2e] no interpreter outside a venv could be filtered to; ' +
            `accepting the first entry. Offered: ${JSON.stringify(entries.map((entry) => entry.text))}`
    );
    await interpreterPick.confirm();
}

/**
 * Drives `deepnote.environments.create`: pick interpreter -> name -> skip packages -> skip
 * description. Retries while the Python extension is still discovering interpreters, and treats
 * "already exists" as success so a retry reuses the environment instead of colliding with it.
 *
 * Each suite passes its own name, so no suite inherits an environment another one set up.
 */
export async function createEnvironment(name: string, options: { useManagedVenv?: boolean } = {}): Promise<void> {
    const driver = VSBrowser.instance.driver;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
        await new Workbench().executeCommand(CREATE_ENV_COMMAND);

        // Either the interpreter quick pick opens, or (no interpreter discovered yet) the command
        // shows a "No Python interpreters found" notification and returns.
        const interpreterPick = await tryOpenInputBox(INTERPRETER_PROMPT_TIMEOUT);
        if (!interpreterPick) {
            await dismissAllNotifications();
            await driver.sleep(INTERPRETER_RETRY_DELAY);
            lastError = new Error('interpreter quick pick did not appear (interpreter discovery not ready?)');
            continue;
        }

        // Every step below drives a quick pick the workbench can tear down under us, so they share
        // one recovery: escape whatever input is open and spend another attempt. Retrying is safe
        // because the create command treats an existing name as success.
        try {
            await driver.wait(
                async () => (await interpreterPick.getQuickPicks()).length > 0,
                QUICK_PICK_TIMEOUT,
                'no Python interpreters were listed'
            );

            await selectInterpreter(interpreterPick, options.useManagedVenv === true);

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
        } catch (error) {
            await interpreterPick.cancel().catch((cancelError) => {
                console.warn('[deepnote-e2e] cancel interpreter quick pick:', cancelError);
            });
            await dismissAllNotifications();
            await driver.sleep(INTERPRETER_RETRY_DELAY);
            lastError = error;
            continue;
        }
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
