/**
 * E2E (ExTester): one agent block driving a three-leg tool loop against a stand-in OpenAI API, so no
 * network call is made. The agent asks for a code block, the extension inserts it as an ephemeral
 * cell and runs it on the kernel, and the real stdout goes back as the tool result; the agent then
 * asks for a markdown block and finally answers.
 *
 * The scripted legs 2 and 3 match on `toolResultContains`, so the agent can only advance if the
 * extension genuinely executed the generated Python and returned its actual output. With aimock's
 * `--strict`, a broken round-trip matches no leg and fails loudly.
 *
 * Executing generated code needs a real kernel: the first run provisions a venv and installs the
 * Deepnote toolkit, which takes minutes.
 */

import { expect } from 'chai';
import { EditorView, InputBox, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    MockOpenAiServer,
    OUTPUT_POLL_INTERVAL,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickRunAll,
    confirmModalDialog,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    pointExtensionHostAtMockServer,
    readNotebookWebviewText,
    selectEnvironmentForNotebook,
    startMockOpenAiServer,
    waitForNotification
} from '../helpers';

// At module scope on purpose — VS Code is already running by the time `before` executes, and it
// inherits this at spawn time. See the function's contract.
pointExtensionHostAtMockServer();

const AGENT_FILE = 'agent-block.deepnote';
const CODE_TOOL_NAME = 'add_code_block';
const MARKDOWN_TOOL_NAME = 'add_markdown_block';

// The extension's tool result for a successful add_markdown_block (agentCellExecutionHandler.ts);
// leg 3 keys off it, so the wording is a coupling to that constant.
const MARKDOWN_BLOCK_ADDED_TEXT = 'Markdown block added.';

// A stable name: createEnvironment treats "already exists" as success, so a leftover environment from
// a previous or retried run is reused rather than colliding — and its provisioned venv with it.
const ENVIRONMENT_NAME = 'E2E Agent Env';

// Once the kernel is up the agent itself talks only to the local mock, so it is bounded by UI and
// extension-host latency. The kernel's own first run is bounded by FIRST_RUN_OUTPUT_TIMEOUT instead.
const AGENT_RUN_TIMEOUT = 60_000;

// Printed by the Python the agent asks for. Only the executed ephemeral code cell can put it in the
// webview: the webview renders outputs and markdown previews, never cell source, and the agent's own
// transcript reports tool output by length rather than by content.
const PYTHON_OUTPUT_MARKER = 'agent-generated-python-ran';
const GENERATED_PYTHON = `print("${PYTHON_OUTPUT_MARKER}")`;

// Reaches the notebook only through the agent's tool call — the streamed transcript never echoes
// tool arguments — so seeing it rendered is what proves an ephemeral markdown cell was inserted.
const EPHEMERAL_MARKDOWN_TEXT = 'Ephemeral markdown written by the E2E agent run';
const FINAL_AGENT_TEXT = 'Summary added as a markdown block.';

// The mock server ignores credentials, but the extension refuses to start an agent run without a
// stored key (and would otherwise block on an input box mid-execution).
const MOCK_API_KEY = 'sk-e2e-mock-key';
// Exact palette label matters: `Workbench.executeCommand` silently runs the first palette entry on a
// mismatch.
const SET_API_KEY_COMMAND = 'Deepnote: Set OpenAI API Key';
const CLEAR_API_KEY_COMMAND = 'Deepnote: Clear OpenAI API Key';
const REVERT_FILE_COMMAND = 'File: Revert File';
// VS Code's save prompt; the bundle stores it with a mnemonic marker ("Do&&n't Save") that is
// stripped before rendering, so the button's text is this.
const DISCARD_CHANGES_BUTTON = "Don't Save";
const API_KEY_SAVED_NOTIFICATION = /OpenAI API key has been saved/;

/** Polls the notebook webview until every marker is present, returning whatever it last read. */
async function awaitWebviewMarkers(markers: string[], timeout: number): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + timeout;
    let text = '';

    while (Date.now() < deadline) {
        text = await readNotebookWebviewText();
        if (markers.every((marker) => text.includes(marker))) {
            return text;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    return text;
}

/** Stores the throwaway key in SecretStorage so the agent run never opens the key prompt. */
async function storeMockOpenAiApiKey(): Promise<void> {
    await new Workbench().executeCommand(SET_API_KEY_COMMAND);

    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await input.setText(MOCK_API_KEY);
    await input.confirm();

    // Confirm the key really landed. Had the palette missed the command, InputBox.create would have
    // bound to the still-open palette and typed the key into it, and the suite would run keyless —
    // surfacing a full AGENT_RUN_TIMEOUT later as a generic missing-marker failure.
    await waitForNotification(API_KEY_SAVED_NOTIFICATION, QUICK_PICK_TIMEOUT, true);
}

describe('Deepnote — running an agent block against a stand-in OpenAI API', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let mockServer: MockOpenAiServer | undefined;
    let screenshot: (label: string) => Promise<string>;

    before(async function () {
        screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(AGENT_FILE);
        cleanupTempDir = copy.cleanup;

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        await openWorkspaceFile(AGENT_FILE);
        await VSBrowser.instance.driver.wait(
            async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(AGENT_FILE)),
            WORKBENCH_TIMEOUT,
            `${AGENT_FILE} did not open`
        );

        // Binds a real kernel for the code the agent generates, replacing the "Select Environment"
        // placeholder controller the auto-selector picks on open. This is also the settle signal it waits
        // on: selectEnvironmentForNotebook returns after the post-binding "switched successfully"
        // toast, so Run All is not racing the auto-selection.
        await createEnvironment(ENVIRONMENT_NAME);
        await selectEnvironmentForNotebook(ENVIRONMENT_NAME, AGENT_FILE);

        // Toasts steal focus from the command palette. Safe to do after the environment flow, which
        // has already driven extension commands and so guarantees `onNotebook:deepnote` activation.
        await dismissAllNotifications();
        await storeMockOpenAiApiKey();
        await screenshot('kernel-connected');
    });

    // Per attempt, not per suite: `.mocharc.js` sets `retries: 1` and `before`/`after` do not run
    // between attempts, so a server started once would still hold the port when the retry starts —
    // and `startMockOpenAiServer`'s pre-flight check would reject it as a leftover, failing the retry
    // for a different reason than the original and losing the real signal.
    //
    // Leg 2 and leg 3 are reachable only via what the extension sends back, so the script itself
    // asserts the round-trip: leg 2 needs the kernel's real stdout, leg 3 the markdown tool's reply.
    beforeEach(async function () {
        mockServer = await startMockOpenAiServer([
            {
                match: { hasToolResult: false },
                response: {
                    toolCall: {
                        arguments: JSON.stringify({ code: GENERATED_PYTHON }),
                        id: 'call_e2e_code',
                        name: CODE_TOOL_NAME
                    }
                }
            },
            {
                match: { toolResultContains: PYTHON_OUTPUT_MARKER },
                response: {
                    toolCall: {
                        arguments: JSON.stringify({ content: EPHEMERAL_MARKDOWN_TEXT }),
                        id: 'call_e2e_markdown',
                        name: MARKDOWN_TOOL_NAME
                    }
                }
            },
            {
                match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                response: { content: FINAL_AGENT_TEXT }
            }
        ]);
    });

    afterEach(async function () {
        await mockServer?.stop().catch((error) => {
            console.warn('[agent-block] stop the mock OpenAI server:', error);
        });
        // Cleared so a failed start cannot leave the next attempt stopping a dead handle.
        mockServer = undefined;
    });

    after(async function () {
        // Filesystem cleanup goes FIRST. The UI steps below can each stall for minutes — this is the
        // one suite that ends with a dirty notebook, so `closeAllEditors` retries against a save modal
        // and the `.catch()`-swallowed revert cannot stop it — and a wedged UI step would otherwise
        // burn SUITE_TIMEOUT with the temp dir never released.
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[agent-block] remove temp workspace dir during cleanup:', error);
        }

        await new WebView().switchBack().catch((error) => {
            console.warn('[agent-block] switch back from webview during cleanup:', error);
        });
        // The inserted ephemeral cell leaves the notebook dirty, and the resulting modal save prompt
        // outlives this suite and blocks the next one in the shared VS Code instance.
        await new Workbench().executeCommand(REVERT_FILE_COMMAND).catch((error) => {
            console.warn('[agent-block] revert notebook during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[agent-block] close all editors during cleanup:', error);
        });

        // Backstop for a revert that did not land: an unanswered save modal blocks the next suite.
        // Gated on an editor surviving the close, because confirmModalDialog polls for the full
        // WORKBENCH_TIMEOUT when no dialog is up — dead time on every green run otherwise.
        const openEditors = await new EditorView().getOpenEditorTitles().catch(() => [] as string[]);
        if (openEditors.length > 0) {
            await confirmModalDialog(DISCARD_CHANGES_BUTTON).catch((error) => {
                console.warn('[agent-block] discard unsaved changes during cleanup:', error);
            });
        }
        // SecretStorage outlives this suite in the shared VS Code instance, so leave no key behind.
        await new Workbench().executeCommand(CLEAR_API_KEY_COMMAND).catch((error) => {
            console.warn('[agent-block] clear the stored OpenAI API key during cleanup:', error);
        });
    });

    // Known limitation of the Mocha retry (`.mocharc.js` sets `retries: 1`): if this times out with an
    // execution still in flight, the retry's clickRunAll may find Interrupt where Run All was and fail
    // for an unrelated reason, losing the original signal. Only reachable on an already-failing test,
    // so it costs debuggability rather than correctness.
    it('executes the code block the agent generates, then inserts its markdown block', async function () {
        // Clears the "OpenAI API key has been saved." and "switched successfully" toasts, which would
        // otherwise intercept the toolbar click.
        await dismissAllNotifications();
        await clickRunAll(AGENT_FILE);

        // Every marker is asserted below, so poll for all of them — a missing one then fails on its
        // own assertion rather than on whichever runs first. Split in two waits because the stages
        // have very different budgets: the generated cell is the first thing to touch the kernel, and
        // that first execution carries the connect cost, while the rest is local. Waiting on the
        // Python marker first also reports a kernel failure as a kernel failure rather than as a
        // missing agent marker.
        await awaitWebviewMarkers([PYTHON_OUTPUT_MARKER], FIRST_RUN_OUTPUT_TIMEOUT);

        const agentMarkers = [
            `[Agent] Tool called: ${CODE_TOOL_NAME}`,
            `[Agent] Tool called: ${MARKDOWN_TOOL_NAME}`,
            EPHEMERAL_MARKDOWN_TEXT,
            FINAL_AGENT_TEXT
        ];
        const webviewText = await awaitWebviewMarkers(agentMarkers, AGENT_RUN_TIMEOUT);

        await screenshot('agent-run');

        expect(webviewText, 'the agent cell did not stream its add_code_block call into the cell output').to.contain(
            `[Agent] Tool called: ${CODE_TOOL_NAME}`
        );
        expect(webviewText, 'the generated code cell did not run on the kernel').to.contain(PYTHON_OUTPUT_MARKER);
        expect(
            webviewText,
            'the agent cell did not stream its add_markdown_block call into the cell output'
        ).to.contain(`[Agent] Tool called: ${MARKDOWN_TOOL_NAME}`);
        expect(webviewText, 'the tool call did not insert an ephemeral markdown cell').to.contain(
            EPHEMERAL_MARKDOWN_TEXT
        );
        expect(webviewText, "the agent's final message was not streamed into the cell output").to.contain(
            FINAL_AGENT_TEXT
        );
    });
});
