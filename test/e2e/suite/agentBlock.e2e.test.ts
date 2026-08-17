/**
 * Agent block E2E vs local aimock; legs 2–3 advance on real tool results (no live OpenAI).
 *
 * Three fixtures share one workspace and one environment — provisioning a second environment costs
 * ~90s of CI and every test here wants the same kernel. Only that setup is shared: each group below
 * opens and binds the notebook it runs, so the groups are order-independent and either can run on
 * its own.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EditorView, VSBrowser, WebView, Workbench } from 'vscode-extension-tester';

import {
    FIRST_RUN_OUTPUT_TIMEOUT,
    MockOpenAiServer,
    SUITE_TIMEOUT,
    WORKBENCH_TIMEOUT,
    assertMarkersStayAbsent,
    awaitWebviewMarkers,
    blockStreamOutputText,
    clearStoredOpenAiApiKey,
    clickCellStatusBarItem,
    clickInterrupt,
    clickRunAll,
    confirmModalDialog,
    copyFixtureToTempDir,
    createEnvironment,
    createScreenshotter,
    dismissAllNotifications,
    openFolderViaDialog,
    openWorkspaceFile,
    pointExtensionHostAtMockServer,
    selectEnvironmentForNotebook,
    startMockOpenAiServer,
    storeMockOpenAiApiKey
} from '../helpers';

pointExtensionHostAtMockServer();

const AGENT_FILE = 'agent-block.deepnote';
const AGENT_BLOCK_ID = 'e2e-agent-block';
// Mixed-batch fixtures: a failing cell before the agent, and a trailing cell after it.
const BATCH_FILE = 'agent-block-batch.deepnote';
const STOP_FILE = 'agent-block-stop.deepnote';
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
const REVERT_FILE_COMMAND = 'File: Revert File';
const DISCARD_CHANGES_BUTTON = "Don't Save";
// Fourth run: the generated cell raises, so the agent must be handed the failure and carry on.
const FAILING_PYTHON_MARKER = 'e2e-agent-code-boom';
const FAILING_GENERATED_PYTHON = `raise ValueError("${FAILING_PYTHON_MARKER}")`;
// addAndExecuteCodeBlock's prefix for a cell that ran and failed (as opposed to one that never ran).
const EXECUTION_FAILED_TEXT = 'Execution failed:';
const FAILURE_RECOVERY_MARKDOWN = 'Recovered from the failed cell and carried on';
const FAILURE_FINAL_AGENT_TEXT = 'Reported the failure as a markdown block.';
// Fifth run: read back from the snapshot sidecar rather than the webview.
const PERSISTED_PYTHON_OUTPUT_MARKER = 'persisted-python-ran';
const PERSISTED_GENERATED_PYTHON = `print("${PERSISTED_PYTHON_OUTPUT_MARKER}")`;
const PERSISTED_MARKDOWN_TEXT = 'Fifth-run markdown from the E2E agent';
const PERSISTED_FINAL_AGENT_TEXT = 'Transcript that must survive the save in full.';
// executeAgentCell's first output item — all that survived the save before the streamed-item fix.
const AGENT_FIRST_OUTPUT_ITEM = '[Agent] Planning next steps...';
const SNAPSHOT_WRITE_TIMEOUT = 60_000;
const SNAPSHOT_POLL_INTERVAL = 1_500;

// Mixed batch, failing first cell: the two markers after it must never render.
const BATCH_FAILURE_MARKER = 'e2e-batch-boom';
const BATCH_TRAILING_MARKER = 'e2e-batch-trailing-ran';
const BATCH_AGENT_PYTHON_MARKER = 'e2e-batch-agent-python-ran';
const BATCH_AGENT_MARKDOWN_TEXT = 'Markdown the agent must never get to write';
const BATCH_AGENT_FINAL_TEXT = 'Summary the agent must never get to write.';
/**
 * How long the forbidden markers must stay away. A batch that carried on renders them within one
 * agent round trip to the local mock (~1–2s) plus one cell execution (~1–3s); this keeps a wide
 * margin over that without being open-ended, since a passing run spends the whole window.
 */
const BATCH_SETTLE_WINDOW = 10_000;

// The generated cell prints, then sleeps: a bounded window in which the notebook is demonstrably
// running and Stop has something to interrupt. Long enough that a slow click still lands inside it,
// and never actually waited out on a passing run.
const STOP_SLEEP_MARKER = 'e2e-stop-sleeping';
const STOP_GENERATED_PYTHON = `print("${STOP_SLEEP_MARKER}", flush=True)\nimport time\ntime.sleep(60)`;
const STOP_TRAILING_MARKER = 'e2e-stop-trailing-ran';
const STOP_MARKDOWN_TEXT = 'Markdown the stopped agent must never write';
const STOP_FINAL_TEXT = 'Summary the stopped agent must never write.';
const AGENT_STOPPED_TEXT = '[Agent] Stopped';
const STOP_ACKNOWLEDGED_TIMEOUT = 30_000;
// Shorter than the batch window: `[Agent] Stopped` already proves the run ended, so this only has
// to outlast the trailing cell that a batch which ignored the stop would dispatch next.
const STOP_SETTLE_WINDOW = 8_000;

/**
 * Keeps exactly one editor open: `clickRunAll` takes the first toolbar in DOM order.
 *
 * A run leaves the notebook dirty, so closing it raises the save prompt. Revert first so the close
 * is clean, and answer the prompt if one appears anyway: an unanswered modal dims the workbench and
 * intercepts every later click, which surfaces as an unrelated "element is visible" timeout in
 * whatever runs next rather than here.
 */
async function openOnly(fileName: string): Promise<void> {
    await new WebView().switchBack().catch((error) => {
        console.warn('[agent-block] switch back from webview before opening an editor:', error);
    });

    const alreadyOpen = await new EditorView().getOpenEditorTitles().catch(() => [] as string[]);
    if (alreadyOpen.length > 0) {
        await new Workbench().executeCommand(REVERT_FILE_COMMAND).catch((error) => {
            console.warn('[agent-block] revert notebook before closing it:', error);
        });
    }

    await new EditorView().closeAllEditors().catch((error) => {
        console.warn('[agent-block] close editors before opening the next notebook:', error);
    });

    // Only when editors survived the close, since `confirmModalDialog` waits out its full timeout
    // and then throws when no dialog is up.
    const stillOpen = await new EditorView().getOpenEditorTitles().catch(() => [] as string[]);
    if (stillOpen.length > 0) {
        await confirmModalDialog(DISCARD_CHANGES_BUTTON).catch((error) => {
            console.warn('[agent-block] discard unsaved changes before opening the next notebook:', error);
        });
        await new EditorView().closeAllEditors().catch((error) => {
            console.warn('[agent-block] close editors after discarding unsaved changes:', error);
        });
    }

    await openWorkspaceFile(fileName);
    await VSBrowser.instance.driver.wait(
        async () => (await new EditorView().getOpenEditorTitles()).some((title) => title.includes(fileName)),
        WORKBENCH_TIMEOUT,
        `${fileName} did not open`
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

describe('Deepnote — running an agent block against a stand-in OpenAI API', function () {
    this.timeout(SUITE_TIMEOUT);

    let cleanupTempDir: (() => void) | undefined;
    let mockServer: MockOpenAiServer | undefined;
    let screenshot: (label: string) => Promise<string>;
    let workspaceDir = '';

    before(async function () {
        screenshot = createScreenshotter(this);

        const copy = copyFixtureToTempDir(AGENT_FILE);
        cleanupTempDir = copy.cleanup;
        workspaceDir = copy.tempDir;

        for (const fixture of [BATCH_FILE, STOP_FILE]) {
            fs.copyFileSync(
                path.resolve(process.cwd(), 'test', 'e2e', 'fixtures', fixture),
                path.join(copy.tempDir, fixture)
            );
        }

        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);
        await openFolderViaDialog(copy.tempDir);
        await VSBrowser.instance.waitForWorkbench(WORKBENCH_TIMEOUT);

        // createEnvironment needs an active deepnote notebook; which one does not matter, and each
        // group below binds the kernel for the notebook it actually runs.
        await openOnly(AGENT_FILE);
        await createEnvironment(ENVIRONMENT_NAME);

        await dismissAllNotifications();
        await storeMockOpenAiApiKey();
        await screenshot('environment-created');
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
        await clearStoredOpenAiApiKey().catch((error) => {
            console.warn('[agent-block] clear the stored OpenAI API key during cleanup:', error);
        });
    });

    describe('one agent block on its own', function () {
        // Opens and binds the notebook this group runs, so the group does not care what ran before
        // it. Closing and reopening drops the block's generated cells, which is why it happens here
        // once and never between the tests below.
        before(async function () {
            await openOnly(AGENT_FILE);
            await selectEnvironmentForNotebook(ENVIRONMENT_NAME, AGENT_FILE);
            await dismissAllNotifications();
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
            await awaitWebviewMarkers(
                [CLEAR_RUN_FINAL_AGENT_TEXT],
                CLEAR_EPHEMERAL_TIMEOUT,
                'ephemeral cells cleared',
                [CLEAR_RUN_PYTHON_OUTPUT_MARKER, CLEAR_RUN_MARKDOWN_TEXT]
            );

            await screenshot('agent-ephemeral-cleared');
        });

        it('hands the agent a failed generated cell and lets the run carry on', async function () {
            mockServer = await startMockOpenAiServer([
                {
                    match: { hasToolResult: false },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ code: FAILING_GENERATED_PYTHON }),
                            id: 'call_e2e_failing_code',
                            name: CODE_TOOL_NAME
                        }
                    }
                },
                // Only a tool result carrying "Execution failed:" reaches this leg. The mock runs with
                // --strict, so if the handler swallowed the failure and reported success instead, this
                // request goes unmatched, the agent errors out, and the markers below never render —
                // which is what makes the assertion about the tool result and not just about the cell.
                {
                    match: { toolResultContains: EXECUTION_FAILED_TEXT },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ content: FAILURE_RECOVERY_MARKDOWN }),
                            id: 'call_e2e_failing_markdown',
                            name: MARKDOWN_TOOL_NAME
                        }
                    }
                },
                {
                    match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                    response: { content: FAILURE_FINAL_AGENT_TEXT }
                }
            ]);

            await dismissAllNotifications();
            await clickRunAll(AGENT_FILE);

            await awaitWebviewMarkers(
                [FAILING_PYTHON_MARKER, FAILURE_RECOVERY_MARKDOWN, FAILURE_FINAL_AGENT_TEXT],
                AGENT_RUN_TIMEOUT,
                'agent run whose generated cell raises'
            );

            await screenshot('agent-generated-cell-failed');
        });

        it('persists every streamed output item to the snapshot, not just the first', async function () {
            mockServer = await startMockOpenAiServer([
                {
                    match: { hasToolResult: false },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ code: PERSISTED_GENERATED_PYTHON }),
                            id: 'call_e2e_persisted_code',
                            name: CODE_TOOL_NAME
                        }
                    }
                },
                {
                    match: { toolResultContains: PERSISTED_PYTHON_OUTPUT_MARKER },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ content: PERSISTED_MARKDOWN_TEXT }),
                            id: 'call_e2e_persisted_markdown',
                            name: MARKDOWN_TOOL_NAME
                        }
                    }
                },
                {
                    match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                    response: { content: PERSISTED_FINAL_AGENT_TEXT }
                }
            ]);

            await dismissAllNotifications();
            await clickRunAll(AGENT_FILE);

            await awaitWebviewMarkers(
                [PERSISTED_PYTHON_OUTPUT_MARKER, PERSISTED_FINAL_AGENT_TEXT],
                AGENT_RUN_TIMEOUT,
                'agent run whose transcript must survive the save'
            );

            // With snapshots on (the default) the main .deepnote has outputs stripped, so the agent's
            // transcript only exists in the sidecar. The save is deferred off queue completion, hence
            // the poll rather than a single read.
            const snapshotsDir = path.join(workspaceDir, 'snapshots');
            const driver = VSBrowser.instance.driver;
            const deadline = Date.now() + SNAPSHOT_WRITE_TIMEOUT;
            let transcript = '';

            while (Date.now() < deadline) {
                const files = fs.existsSync(snapshotsDir)
                    ? fs.readdirSync(snapshotsDir).filter((file) => file.endsWith('_latest.snapshot.deepnote'))
                    : [];
                transcript =
                    files.length > 0
                        ? blockStreamOutputText(
                              fs.readFileSync(path.join(snapshotsDir, files[0]), 'utf8'),
                              AGENT_BLOCK_ID
                          )
                        : '';

                if (transcript.includes(PERSISTED_FINAL_AGENT_TEXT)) {
                    break;
                }

                await driver.sleep(SNAPSHOT_POLL_INTERVAL);
            }

            // The first item alone is what a truncating converter leaves behind, so requiring it AND the
            // later ones is the whole assertion: the run is on disk and it is not just its opening line.
            for (const expected of [
                AGENT_FIRST_OUTPUT_ITEM,
                `[Agent] Tool called: ${CODE_TOOL_NAME}`,
                `[Agent] Tool called: ${MARKDOWN_TOOL_NAME}`,
                PERSISTED_FINAL_AGENT_TEXT
            ]) {
                if (!transcript.includes(expected)) {
                    throw new Error(
                        `Saved snapshot is missing ${JSON.stringify(expected)} — the agent's streamed output items ` +
                            `did not all survive the save. Saved transcript: ${JSON.stringify(transcript)}`
                    );
                }
            }
        });
    });

    describe('a mixed batch of kernel cells and an agent block', function () {
        // Each test here opens and binds the notebook it needs, so both stand alone: run either by
        // itself, in either order, or after the group above, and it sets up the same state.
        it('stops at a failing cell instead of running the agent block and the cell after it', async function () {
            // Scripted so a batch that carried on has something to render. Nothing should reach the mock:
            // if these legs are never requested the agent never started, which is the point.
            mockServer = await startMockOpenAiServer([
                {
                    match: { hasToolResult: false },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ code: `print("${BATCH_AGENT_PYTHON_MARKER}")` }),
                            id: 'call_e2e_batch_code',
                            name: CODE_TOOL_NAME
                        }
                    }
                },
                {
                    match: { toolResultContains: BATCH_AGENT_PYTHON_MARKER },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ content: BATCH_AGENT_MARKDOWN_TEXT }),
                            id: 'call_e2e_batch_markdown',
                            name: MARKDOWN_TOOL_NAME
                        }
                    }
                },
                {
                    match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                    response: { content: BATCH_AGENT_FINAL_TEXT }
                }
            ]);

            await openOnly(BATCH_FILE);
            await selectEnvironmentForNotebook(ENVIRONMENT_NAME, BATCH_FILE);
            await dismissAllNotifications();
            await clickRunAll(BATCH_FILE);

            await awaitWebviewMarkers(
                [BATCH_FAILURE_MARKER],
                FIRST_RUN_OUTPUT_TIMEOUT,
                'traceback from the failing cell'
            );

            await assertMarkersStayAbsent(
                [BATCH_AGENT_PYTHON_MARKER, BATCH_AGENT_MARKDOWN_TEXT, BATCH_AGENT_FINAL_TEXT, BATCH_TRAILING_MARKER],
                BATCH_SETTLE_WINDOW,
                'a failing cell must end the batch, so neither the agent block nor the cell after it runs'
            );

            await screenshot('batch-stopped-at-failure');
        });

        it('stops the agent and the cell after it when Interrupt is clicked mid-run', async function () {
            mockServer = await startMockOpenAiServer([
                {
                    match: { hasToolResult: false },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ code: STOP_GENERATED_PYTHON }),
                            id: 'call_e2e_stop_code',
                            name: CODE_TOOL_NAME
                        }
                    }
                },
                // Reached only if the agent survived the stop and asked for its next turn.
                {
                    match: { toolResultContains: STOP_SLEEP_MARKER },
                    response: {
                        toolCall: {
                            arguments: JSON.stringify({ content: STOP_MARKDOWN_TEXT }),
                            id: 'call_e2e_stop_markdown',
                            name: MARKDOWN_TOOL_NAME
                        }
                    }
                },
                {
                    match: { toolResultContains: MARKDOWN_BLOCK_ADDED_TEXT },
                    response: { content: STOP_FINAL_TEXT }
                }
            ]);

            await openOnly(STOP_FILE);
            await selectEnvironmentForNotebook(ENVIRONMENT_NAME, STOP_FILE);
            await dismissAllNotifications();
            await clickRunAll(STOP_FILE);

            // Both markers, not just the sleep one: a Mocha retry starts with the previous attempt's
            // generated cell still on screen, and the agent's own transcript is cleared at run start, so
            // the tool-call line is what proves we are looking at this attempt.
            await awaitWebviewMarkers(
                [`[Agent] Tool called: ${CODE_TOOL_NAME}`, STOP_SLEEP_MARKER],
                AGENT_RUN_TIMEOUT,
                'the generated cell reached its sleep, so the notebook is running and Stop has something to interrupt'
            );

            await clickInterrupt(STOP_FILE);

            await awaitWebviewMarkers(
                [AGENT_STOPPED_TEXT],
                STOP_ACKNOWLEDGED_TIMEOUT,
                'the agent reports the stop rather than treating the interrupted cell as a retryable failure',
                [STOP_MARKDOWN_TEXT, STOP_FINAL_TEXT]
            );

            await assertMarkersStayAbsent(
                [STOP_MARKDOWN_TEXT, STOP_FINAL_TEXT, STOP_TRAILING_MARKER],
                STOP_SETTLE_WINDOW,
                'a stopped agent ends the batch, so nothing after it runs'
            );

            await screenshot('batch-stopped-by-interrupt');
        });
    });
});
