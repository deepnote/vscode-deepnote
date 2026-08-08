/** Agent block E2E vs local aimock; legs 2–3 advance on real tool results (no live OpenAI). */

import { EditorView, InputBox, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    MockOpenAiServer,
    OUTPUT_POLL_INTERVAL,
    QUICK_PICK_TIMEOUT,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    clickCellStatusBarItem,
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

pointExtensionHostAtMockServer();

const AGENT_FILE = 'agent-block.deepnote';
const CODE_TOOL_NAME = 'add_code_block';
const MARKDOWN_TOOL_NAME = 'add_markdown_block';
// Leg 3 match: agentCellExecutionHandler add_markdown_block tool result.
const MARKDOWN_BLOCK_ADDED_TEXT = 'Markdown block added.';
const ENVIRONMENT_NAME = 'E2E Agent Env';
const AGENT_RUN_TIMEOUT = 60_000;
const PYTHON_OUTPUT_MARKER = 'agent-generated-python-ran';
const GENERATED_PYTHON = `print("${PYTHON_OUTPUT_MARKER}")`;
const EPHEMERAL_MARKDOWN_TEXT = 'Ephemeral markdown written by the E2E agent run';
// aimock emits 20-char chunks (multiple text_delta).
const FINAL_AGENT_TEXT = 'Summary added as a markdown block, streamed across several deltas.';
// Disjoint from first-run markers (assertOccurrences below).
const RERUN_PYTHON_OUTPUT_MARKER = 'rerun-python-ran';
const RERUN_GENERATED_PYTHON = `print("${RERUN_PYTHON_OUTPUT_MARKER}")`;
const RERUN_MARKDOWN_TEXT = 'Second-run markdown from the E2E agent';
const RERUN_FINAL_AGENT_TEXT = 'Re-run summary added as a markdown block.';
// executeAgentCell stale-run error substring.
const STALE_CELLS_ERROR_TEXT = 'from its previous run';
// Third run, disjoint from both prior runs so the clear test stands on its own.
const CLEAR_RUN_PYTHON_OUTPUT_MARKER = 'clear-run-python-ran';
const CLEAR_RUN_GENERATED_PYTHON = `print("${CLEAR_RUN_PYTHON_OUTPUT_MARKER}")`;
const CLEAR_RUN_MARKDOWN_TEXT = 'Third-run markdown from the E2E agent';
const CLEAR_RUN_FINAL_AGENT_TEXT = 'Clear-run summary added as a markdown block.';
// AgentCellStatusBarProvider button and its confirmation.
const CLEAR_EPHEMERAL_BUTTON = 'Clear ephemeral blocks';
const CLEAR_EPHEMERAL_CONFIRM = 'Clear';
const CLEAR_EPHEMERAL_CONFIRM_TEXT = 'ephemeral block';
const CLEAR_EPHEMERAL_TIMEOUT = 30_000;
const MOCK_API_KEY = 'sk-e2e-mock-key';
const SET_API_KEY_COMMAND = 'Deepnote: Set OpenAI API Key';
const CLEAR_API_KEY_COMMAND = 'Deepnote: Clear OpenAI API Key';
const REVERT_FILE_COMMAND = 'File: Revert File';
const DISCARD_CHANGES_BUTTON = "Don't Save";
const API_KEY_SAVED_NOTIFICATION = /OpenAI API key has been saved/;

async function awaitWebviewMarkers(
    markers: string[],
    timeout: number,
    context: string,
    absentMarkers: string[] = []
): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + timeout;
    let text = '';

    while (Date.now() < deadline) {
        text = await readNotebookWebviewText();
        const missing = markers.filter((marker) => !text.includes(marker));
        const lingering = absentMarkers.filter((marker) => text.includes(marker));
        if (missing.length === 0 && lingering.length === 0) {
            return text;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    const missing = markers.filter((marker) => !text.includes(marker));
    const lingering = absentMarkers.filter((marker) => text.includes(marker));
    throw new Error(
        `Timed out after ${timeout}ms waiting for notebook webview (${context}). Missing: ${JSON.stringify(missing)}. ` +
            `Lingering: ${JSON.stringify(lingering)}. Last text: ${JSON.stringify(text)}`
    );
}

function assertRenderedContiguously(transcript: string, expected: string): void {
    if (transcript.includes(expected)) {
        return;
    }

    throw new Error(
        `Agent transcript does not contain ${JSON.stringify(expected)} as one unbroken run — appended stdout ` +
            `items are not rendering as a single block. Full transcript: ${JSON.stringify(transcript)}`
    );
}

function assertOccurrences(rendered: string, needle: string, expected: number): void {
    const actual = rendered.split(needle).length - 1;

    if (actual === expected) {
        return;
    }

    throw new Error(
        `Expected ${expected} occurrence(s) of ${JSON.stringify(needle)} in the notebook, found ${actual}. ` +
            `Full text: ${JSON.stringify(rendered)}`
    );
}

async function storeMockOpenAiApiKey(): Promise<void> {
    await new Workbench().executeCommand(SET_API_KEY_COMMAND);

    const input = await InputBox.create(QUICK_PICK_TIMEOUT);
    await input.setText(MOCK_API_KEY);
    await input.confirm();

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

        await createEnvironment(ENVIRONMENT_NAME);
        await selectEnvironmentForNotebook(ENVIRONMENT_NAME, AGENT_FILE);

        await dismissAllNotifications();
        await storeMockOpenAiApiKey();
        await screenshot('kernel-connected');
    });

    async function releaseMockServer(): Promise<void> {
        await mockServer?.stop().catch((error) => {
            console.warn('[agent-block] stop the mock OpenAI server:', error);
        });
        mockServer = undefined;
    }

    beforeEach(releaseMockServer);
    afterEach(releaseMockServer);

    after(async function () {
        try {
            cleanupTempDir?.();
        } catch (error) {
            console.warn('[agent-block] remove temp workspace dir during cleanup:', error);
        }

        await new WebView().switchBack().catch((error) => {
            console.warn('[agent-block] switch back from webview during cleanup:', error);
        });
        await new Workbench().executeCommand(REVERT_FILE_COMMAND).catch((error) => {
            console.warn('[agent-block] revert notebook during cleanup:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[agent-block] close all editors during cleanup:', error);
        });

        const openEditors = await new EditorView().getOpenEditorTitles().catch(() => [] as string[]);
        if (openEditors.length > 0) {
            await confirmModalDialog(DISCARD_CHANGES_BUTTON).catch((error) => {
                console.warn('[agent-block] discard unsaved changes during cleanup:', error);
            });
        }
        await new Workbench().executeCommand(CLEAR_API_KEY_COMMAND).catch((error) => {
            console.warn('[agent-block] clear the stored OpenAI API key during cleanup:', error);
        });
    });

    it('executes the generated code block, inserts its markdown block, and streams one transcript', async function () {
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

        await dismissAllNotifications();
        await clickRunAll(AGENT_FILE);

        await awaitWebviewMarkers([PYTHON_OUTPUT_MARKER], FIRST_RUN_OUTPUT_TIMEOUT, 'generated code cell stdout');

        const transcript = await awaitWebviewMarkers(
            [
                `[Agent] Tool called: ${CODE_TOOL_NAME}`,
                `[Agent] Tool called: ${MARKDOWN_TOOL_NAME}`,
                EPHEMERAL_MARKDOWN_TEXT,
                FINAL_AGENT_TEXT
            ],
            AGENT_RUN_TIMEOUT,
            'agent tool loop and ephemeral markdown'
        );

        await screenshot('agent-run');

        assertRenderedContiguously(
            transcript,
            `[Agent] Tool called: ${MARKDOWN_TOOL_NAME}\n\n[Agent] Tool output: ${MARKDOWN_TOOL_NAME}`
        );
        assertRenderedContiguously(transcript, `[Agent] Text:\n${FINAL_AGENT_TEXT}`);
    });

    // Serial with prior it — block still owns first-run cells.
    it('clears the cells its previous run generated instead of stacking a second copy', async function () {
        mockServer = await startMockOpenAiServer([
            {
                match: { hasToolResult: false },
                response: {
                    toolCall: {
                        arguments: JSON.stringify({ code: RERUN_GENERATED_PYTHON }),
                        id: 'call_e2e_rerun_code',
                        name: CODE_TOOL_NAME
                    }
                }
            },
            {
                match: { toolResultContains: RERUN_PYTHON_OUTPUT_MARKER },
                response: {
                    toolCall: {
                        arguments: JSON.stringify({ content: RERUN_MARKDOWN_TEXT }),
                        id: 'call_e2e_rerun_markdown',
                        name: MARKDOWN_TOOL_NAME
                    }
                }
            },
            {
                match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                response: { content: RERUN_FINAL_AGENT_TEXT }
            }
        ]);

        await dismissAllNotifications();
        await clickRunAll(AGENT_FILE);

        const rendered = await awaitWebviewMarkers(
            [RERUN_PYTHON_OUTPUT_MARKER, RERUN_MARKDOWN_TEXT, RERUN_FINAL_AGENT_TEXT],
            AGENT_RUN_TIMEOUT,
            'second agent run'
        );

        await screenshot('agent-rerun');

        // assertOccurrences — retries would duplicate markers.
        assertOccurrences(rendered, PYTHON_OUTPUT_MARKER, 0);
        assertOccurrences(rendered, EPHEMERAL_MARKDOWN_TEXT, 0);
        assertOccurrences(rendered, RERUN_PYTHON_OUTPUT_MARKER, 1);
        assertOccurrences(rendered, RERUN_MARKDOWN_TEXT, 1);
        assertOccurrences(rendered, STALE_CELLS_ERROR_TEXT, 0);
    });

    // Self-contained: generates the run it clears, so it survives --grep and a Mocha retry (Run All
    // drops any stale generated cells first).
    it('clears the whole generated run from the agent block status bar button', async function () {
        mockServer = await startMockOpenAiServer([
            {
                match: { hasToolResult: false },
                response: {
                    toolCall: {
                        arguments: JSON.stringify({ code: CLEAR_RUN_GENERATED_PYTHON }),
                        id: 'call_e2e_clear_code',
                        name: CODE_TOOL_NAME
                    }
                }
            },
            {
                match: { toolResultContains: CLEAR_RUN_PYTHON_OUTPUT_MARKER },
                response: {
                    toolCall: {
                        arguments: JSON.stringify({ content: CLEAR_RUN_MARKDOWN_TEXT }),
                        id: 'call_e2e_clear_markdown',
                        name: MARKDOWN_TOOL_NAME
                    }
                }
            },
            {
                match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                response: { content: CLEAR_RUN_FINAL_AGENT_TEXT }
            }
        ]);

        await dismissAllNotifications();
        await clickRunAll(AGENT_FILE);

        await awaitWebviewMarkers(
            [CLEAR_RUN_PYTHON_OUTPUT_MARKER, CLEAR_RUN_MARKDOWN_TEXT, CLEAR_RUN_FINAL_AGENT_TEXT],
            AGENT_RUN_TIMEOUT,
            'agent run whose cells the button clears'
        );

        await clickCellStatusBarItem(CLEAR_EPHEMERAL_BUTTON);
        await confirmModalDialog(CLEAR_EPHEMERAL_CONFIRM, { messageIncludes: CLEAR_EPHEMERAL_CONFIRM_TEXT });

        // The button lives on the agent block and takes both cells its run generated. Requiring the
        // agent's own transcript to survive keeps an unreadable webview (which reads as '') from
        // passing this as "the generated cells are gone".
        await awaitWebviewMarkers([CLEAR_RUN_FINAL_AGENT_TEXT], CLEAR_EPHEMERAL_TIMEOUT, 'ephemeral cells cleared', [
            CLEAR_RUN_PYTHON_OUTPUT_MARKER,
            CLEAR_RUN_MARKDOWN_TEXT
        ]);

        await screenshot('agent-ephemeral-cleared');
    });
});
