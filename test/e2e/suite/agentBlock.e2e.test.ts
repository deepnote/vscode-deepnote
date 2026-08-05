/**
 * Agent block E2E: three-leg tool loop against a local aimock server (no live OpenAI calls).
 * Legs 2–3 match on tool results, so the mock only advances after real kernel stdout and
 * markdown tool replies. First kernel run can take minutes (venv + toolkit).
 */

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

pointExtensionHostAtMockServer();

const AGENT_FILE = 'agent-block.deepnote';
const CODE_TOOL_NAME = 'add_code_block';
const MARKDOWN_TOOL_NAME = 'add_markdown_block';
// Coupled to agentCellExecutionHandler tool result for add_markdown_block (leg 3 match).
const MARKDOWN_BLOCK_ADDED_TEXT = 'Markdown block added.';
const ENVIRONMENT_NAME = 'E2E Agent Env';
const AGENT_RUN_TIMEOUT = 60_000;
const PYTHON_OUTPUT_MARKER = 'agent-generated-python-ran';
const GENERATED_PYTHON = `print("${PYTHON_OUTPUT_MARKER}")`;
const EPHEMERAL_MARKDOWN_TEXT = 'Ephemeral markdown written by the E2E agent run';
// aimock streams content in 20-character chunks, so an answer this long reaches the agent cell as
// several text_delta events — one appended output item each.
const FINAL_AGENT_TEXT = 'Summary added as a markdown block, streamed across several deltas.';
const MOCK_API_KEY = 'sk-e2e-mock-key';
const SET_API_KEY_COMMAND = 'Deepnote: Set OpenAI API Key';
const CLEAR_API_KEY_COMMAND = 'Deepnote: Clear OpenAI API Key';
const REVERT_FILE_COMMAND = 'File: Revert File';
const DISCARD_CHANGES_BUTTON = "Don't Save";
const API_KEY_SAVED_NOTIFICATION = /OpenAI API key has been saved/;

async function awaitWebviewMarkers(markers: string[], timeout: number, context: string): Promise<string> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + timeout;
    let text = '';

    while (Date.now() < deadline) {
        text = await readNotebookWebviewText();
        const missing = markers.filter((marker) => !text.includes(marker));
        if (missing.length === 0) {
            return text;
        }

        await driver.sleep(OUTPUT_POLL_INTERVAL);
    }

    const missing = markers.filter((marker) => !text.includes(marker));
    throw new Error(
        `Timed out after ${timeout}ms waiting for notebook webview (${context}). Missing: ${JSON.stringify(missing)}. ` +
            `Last text: ${JSON.stringify(text)}`
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

        // agentCellExecutionHandler appends one stdout item per agent event instead of re-sending the
        // transcript, which only pays off if the renderer joins those items back into one block —
        // something only a real renderer can show: a section boundary keeps its blank line, and an
        // answer split across several deltas arrives unbroken.
        assertRenderedContiguously(
            transcript,
            `[Agent] Tool called: ${MARKDOWN_TOOL_NAME}\n\n[Agent] Tool output: ${MARKDOWN_TOOL_NAME}`
        );
        assertRenderedContiguously(transcript, `[Agent] Text:\n${FINAL_AGENT_TEXT}`);
    });
});
