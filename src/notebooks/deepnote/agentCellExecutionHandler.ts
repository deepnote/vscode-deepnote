import {
    CancellationError,
    CancellationToken,
    NotebookCell,
    NotebookCellData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookController,
    NotebookDocument,
    NotebookEdit,
    NotebookRange,
    WorkspaceEdit,
    commands,
    window,
    workspace
} from 'vscode';

import { AgentBlock, DeepnoteBlock, extractOutputsText } from '@deepnote/blocks';
import {
    AgentBlockContext,
    AgentStreamEvent,
    executeAgentBlock,
    serializeNotebookContextFromBlocks
} from '@deepnote/runtime-core';

import { translateCellDisplayOutput } from '../../kernels/execution/helpers';
import { IEncryptedStorage } from '../../platform/common/application/types';
import type { IDisposable } from '../../platform/common/types';
import { createDeferred, sleep } from '../../platform/common/utils/async';
import { dispose } from '../../platform/common/utils/lifecycle';
import { uuidUtils } from '../../platform/common/uuid';
import { ServiceContainer } from '../../platform/ioc/container';
import { logger } from '../../platform/logging';
import { Cancellation } from '../../platform/common/cancellation';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { IDeepnoteNotebookManager } from '../types';
import {
    generateBlockId,
    generateSortingKey,
    getBlockId,
    getEphemeralCellAgentSourceBlockId,
    isAgentCell
} from './dataConversionUtils';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { getOrPromptOpenAiApiKey } from './deepnoteSecretStore';
import { removeEphemeralCellsOwnedBy } from './ephemeralCellCleanup';

/** Project MCP servers and integrations from the `.deepnote` file (CLI ExecutionEngine parity). Callers must gate on `workspace.isTrusted` — MCP spawn is arbitrary command execution. */
function getProjectAgentContext(notebook: NotebookDocument): Pick<AgentBlockContext, 'mcpServers' | 'integrations'> {
    const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
    const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;

    if (!projectId || !notebookId) {
        return { mcpServers: [], integrations: [] };
    }

    const manager = ServiceContainer.instance.tryGet<IDeepnoteNotebookManager>(IDeepnoteNotebookManager);
    const project = manager?.getProjectForNotebook(projectId, notebookId)?.project;
    const mcpServers = project?.settings?.mcpServers ?? [];
    const integrations = project?.integrations ?? [];

    if (mcpServers.length > 0) {
        logger.info(
            `Agent cell: using ${mcpServers.length} project MCP server(s): ${mcpServers.map((s) => s.name).join(', ')}`
        );
    }

    if (integrations.length > 0) {
        logger.info(
            `Agent cell: using ${integrations.length} project integration(s): ${integrations
                .map((i) => i.name)
                .join(', ')}`
        );
    }

    return { mcpServers, integrations };
}

// Wording matches @deepnote/runtime-core ExecutionEngine so backend and extension runs look the same to the agent.
const MARKDOWN_BLOCK_ADDED_TEXT = 'Markdown block added.';
const NO_OUTPUT_TEXT = '(no output)';

function notebookCellDataFromCell(cell: NotebookCell): NotebookCellData {
    return {
        kind: cell.kind,
        value: cell.document.getText(),
        languageId: cell.document.languageId,
        metadata: cell.metadata,
        outputs: [...(cell.outputs || [])]
    };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function serializeNotebookContext({
    cells,
    notebookName
}: {
    cells: NotebookCell[];
    notebookName: string;
}): string {
    const converter = new DeepnoteDataConverter();

    const blocks = cells.reduce<DeepnoteBlock[]>((acc, cell) => {
        try {
            const block = converter.convertCellToBlock(notebookCellDataFromCell(cell), cell.index);
            acc.push(block);
        } catch (error) {
            logger.error(`Error converting cell to block: ${error}`);
        }
        return acc;
    }, []);

    return serializeNotebookContextFromBlocks({ blocks, notebookName });
}

function joinMultilineString(value: unknown): unknown {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value.join('') : value;
}

/** Join nbformat line arrays before `extractOutputsText` — `String(array)` inserts commas between lines. */
function normalizeOutputsForTextExtraction(outputs: unknown[]): unknown[] {
    return outputs.map((output) => {
        const candidate = output as { output_type?: unknown; text?: unknown; data?: unknown } | null;

        if (candidate?.output_type === 'stream') {
            return { ...candidate, text: joinMultilineString(candidate.text) };
        }

        if (
            (candidate?.output_type === 'execute_result' || candidate?.output_type === 'display_data') &&
            candidate.data != null &&
            typeof candidate.data === 'object'
        ) {
            const data = Object.fromEntries(
                Object.entries(candidate.data).map(([mime, value]) => [
                    mime,
                    mime.startsWith('text/') ? joinMultilineString(value) : value
                ])
            );

            return { ...candidate, data };
        }

        return output;
    });
}

export function describeExecutionOutputs(outputs: unknown[]): string {
    return extractOutputsText(normalizeOutputsForTextExtraction(outputs), { includeTraceback: true }) || NO_OUTPUT_TEXT;
}

export interface ExecuteAgentCellOptions {
    executeAgentBlockFn?: typeof executeAgentBlock;
}

/**
 * True for both the host's own cancellation and the `AbortError` that runtime-core raises from
 * `signal.throwIfAborted()`. `isCancellationError` covers only the former.
 */
function isStopped(error: unknown): boolean {
    return error instanceof CancellationError || (error instanceof Error && error.name === 'AbortError');
}

/** Outlasts the 200ms VS Code waits before releasing a cell's output height (CellOutputContainer#_validateFinalOutputHeight). */
const OUTPUT_HEIGHT_RELEASE_DELAY = 400;

/**
 * Empties the cell's outputs before the run writes its first transcript line, so a re-run is laid
 * out at what it prints rather than at what the run before it printed.
 *
 * VS Code floors a cell's output area at the height it had when its execution was created, and only
 * schedules the release (200ms later) on an output change that lands while that execution is not yet
 * running. It creates the execution before dispatching to the controller, so by the time any of this
 * code runs the floor is already the previous transcript's height, and every write the run makes —
 * `NotebookCellExecution.clearOutput` included — comes too late to release it: the cell holds that
 * height as blank space until the run ends. Clearing through `notebook.cell.clearOutputs` while the
 * execution is still unconfirmed is what schedules the release, and the wait after it is what stops
 * the run's own first output write from cancelling the release again.
 *
 * The command takes no arguments and resolves its target from the focused cell of the active
 * notebook editor, hence the focus and the restore around it — the selection and the command travel
 * the same extension-host channel, so the focus is in place by the time the command is handled. Skips
 * a notebook that is not the active editor rather than reaching for it: the command would clear
 * whichever cell that editor has focused, and losing another cell's outputs is far worse than
 * leaving this one stretched.
 */
async function discardPreviousTranscript(cell: NotebookCell): Promise<void> {
    const editor = window.activeNotebookEditor;

    if (cell.index < 0 || cell.outputs.length === 0 || editor?.notebook !== cell.notebook) {
        return;
    }

    const previousSelections = editor.selections;

    try {
        editor.selection = new NotebookRange(cell.index, cell.index + 1);

        await commands.executeCommand('notebook.cell.clearOutputs');
    } catch (error) {
        logger.warn('Agent cell: could not clear the previous transcript before starting the run', error);

        return;
    } finally {
        editor.selections = previousSelections;
    }

    // Waited out with the selection already back where it was; only the outputs matter here.
    await sleep(OUTPUT_HEIGHT_RELEASE_DELAY);
}

/**
 * Runs an agent block into the cell output and inserts generated cells below.
 * Call `removeEphemeralCellsForAgentBlocks` on the batch first. Never rejects — errors become stderr on the cell.
 *
 * `token` stops the run, bridged to the `AbortSignal` runtime-core forwards to `agent.stream`, so the
 * in-flight model request is aborted rather than left to finish. Throwing from a tool callback cannot
 * stop it: runtime-core catches that and hands the model an `Execution error: …` string to retry.
 */
export async function executeAgentCell(
    cell: NotebookCell,
    controller: NotebookController,
    encryptedStorage: IEncryptedStorage,
    token: CancellationToken,
    options?: ExecuteAgentCellOptions
): Promise<void> {
    const executeAgentBlockFn = options?.executeAgentBlockFn ?? executeAgentBlock;

    await discardPreviousTranscript(cell);

    if (token.isCancellationRequested) {
        throw new CancellationError();
    }

    const execution = controller.createNotebookCellExecution(cell);
    const stopController = new AbortController();
    const stopSubscription = token.onCancellationRequested(() => stopController.abort());

    // The agent runs off the kernel, so nothing announces it on the internal shim — the only source
    // SnapshotService and the execute_cell analytics read. Without this the run is invisible to both.
    const endExecution = (success: boolean) => {
        stopSubscription.dispose();
        execution.end(success, Date.now());
        notebookCellExecutions.changeCellState(cell, NotebookCellExecutionState.Idle);
    };

    try {
        execution.start(Date.now());
        notebookCellExecutions.changeCellState(cell, NotebookCellExecutionState.Executing);

        const prompt = cell.document.getText();

        // runtime-core awaits each event; append deltas only (O(n) over the EH boundary).
        const output = new NotebookCellOutput([NotebookCellOutputItem.stdout(`[Agent] Planning next steps...`)]);
        await execution.replaceOutput([output]);

        const dataConverter = new DeepnoteDataConverter();
        const deepnoteBlock = dataConverter.convertCellToBlock(notebookCellDataFromCell(cell), cell.index);
        const agentBlock: AgentBlock | null = deepnoteBlock.type === 'agent' ? deepnoteBlock : null;

        if (agentBlock == null) {
            throw new Error('Cell is not an agent cell');
        }

        const staleCellCount = cell.notebook
            .getCells()
            .filter((c) => getEphemeralCellAgentSourceBlockId(c) === agentBlock.id).length;

        if (staleCellCount > 0) {
            throw new Error(
                `Agent block ${agentBlock.id} still has ${staleCellCount} generated cell(s) from its previous run`
            );
        }

        const openAiToken = await getOrPromptOpenAiApiKey(encryptedStorage);

        let lastAgentEventType: AgentStreamEvent['type'] | undefined;

        // Caller must clear scratch cells before the batch; context serialization does not filter them.
        const notebookContext = serializeNotebookContext({
            cells: cell.notebook.getCells().filter((c) => c.index !== cell.index),
            notebookName: (cell.notebook.metadata?.deepnoteNotebookName as string | undefined) ?? ''
        });

        const context: AgentBlockContext = {
            openAiToken,
            ...getProjectAgentContext(cell.notebook),
            notebookContext,
            signal: stopController.signal,
            addMarkdownBlock: async ({ content }: { content: string }) => {
                Cancellation.throwIfCanceled(token);

                try {
                    await insertEphemeralCell(cell.notebook, cell.index, agentBlock.id, 'markdown', content);

                    return MARKDOWN_BLOCK_ADDED_TEXT;
                } catch (error) {
                    return `Failed to add markdown block: ${toError(error).message}`;
                }
            },
            addAndExecuteCodeBlock: async ({ code }: { code: string }) => {
                Cancellation.throwIfCanceled(token);

                try {
                    const insertedCell = await insertEphemeralCell(
                        cell.notebook,
                        cell.index,
                        agentBlock.id,
                        'code',
                        code
                    );

                    const { success, outputs, error } = await executeEphemeralCell(insertedCell, token);
                    const outputText = error ?? describeExecutionOutputs(outputs);

                    return success ? `Output:\n${outputText}` : `Execution failed:\n${outputText}`;
                } catch (error) {
                    if (isStopped(error)) {
                        throw error;
                    }

                    return `Execution error: ${toError(error).message}`;
                }
            },
            onAgentEvent: async (event: AgentStreamEvent) => {
                // Runs in runtime-core's own stream loop, which has no catch — the one place the host
                // can end the run rather than merely refuse it.
                Cancellation.throwIfCanceled(token);

                logger.trace(`Agent event: ${event.type}`);

                let delta = lastAgentEventType !== event.type ? `\n\n` : '';

                switch (event.type) {
                    case 'tool_called':
                        delta += `[Agent] Tool called: ${event.toolName}`;
                        break;
                    case 'tool_output':
                        delta += `[Agent] Tool output: ${event.toolName}\n`;
                        delta += `[Agent] Tool output length: ${event.output?.length}`;
                        break;
                    case 'text_delta':
                        if (lastAgentEventType !== 'text_delta') {
                            delta += `[Agent] Text:\n`;
                        }
                        delta += event.text;
                        break;
                    case 'reasoning_delta':
                        if (lastAgentEventType !== 'reasoning_delta') {
                            delta += `[Agent] Reasoning:\n`;
                        }
                        delta += event.text;
                        break;
                    default:
                        event satisfies never;
                }
                lastAgentEventType = event.type;

                await execution.appendOutputItems(NotebookCellOutputItem.stdout(delta), output);
            }
        };

        logger.info(
            `Agent cell: starting executeAgentBlock, model=${agentBlock.metadata.deepnote_agent_model}, prompt length=${prompt.length}`
        );
        const result = await executeAgentBlockFn(agentBlock, context);
        logger.info(`Agent cell: executeAgentBlock completed, finalOutput length=${result.finalOutput.length}`);

        endExecution(true);
    } catch (error) {
        if (isStopped(error)) {
            logger.info('Agent cell execution stopped');

            const stoppedOutput = new NotebookCellOutput([NotebookCellOutputItem.stderr('[Agent] Stopped')]);

            await execution.appendOutput([stoppedOutput]).then(undefined, () => undefined);
            endExecution(false);

            return;
        }

        // logger.error does not print stacks unless isJupyterError — log stack explicitly.
        logger.error('Agent cell execution failed', error);
        if (error instanceof Error) {
            if (error.cause) {
                logger.error('Agent error cause:', error.cause);
            }
            if (error.stack) {
                logger.error('Agent error stack:', error.stack);
            }
        }

        const message = error instanceof Error ? error.message : String(error);
        const stderrOutput = new NotebookCellOutput([NotebookCellOutputItem.stderr(message)]);
        await execution.appendOutput([stderrOutput]).then(undefined, () => undefined);
        endExecution(false);
    }
}

function getInsertIndexAfterAgentCell(
    notebook: NotebookDocument,
    agentCellIndex: number,
    agentBlockId: string
): number {
    let index = agentCellIndex + 1;

    while (index < notebook.cellCount) {
        if (getEphemeralCellAgentSourceBlockId(notebook.cellAt(index)) === agentBlockId) {
            index++;
        } else {
            break;
        }
    }

    return index;
}

/** Inserts an ephemeral cell after the agent; returns the created cell resolved by block id (`cellAt` clamps bad indices). */
async function insertEphemeralCell(
    notebook: NotebookDocument,
    agentCellIndex: number,
    agentBlockId: string,
    blockType: 'code' | 'markdown',
    content: string
): Promise<NotebookCell> {
    const insertIndex = getInsertIndexAfterAgentCell(notebook, agentCellIndex, agentBlockId);

    const block: DeepnoteBlock = {
        type: blockType,
        id: generateBlockId(),
        blockGroup: uuidUtils.generateUuid(),
        sortingKey: generateSortingKey(insertIndex),
        content,
        metadata: {
            is_ephemeral: true,
            agent_source_block_id: agentBlockId
        }
    };

    const converter = new DeepnoteDataConverter();
    const [cellData] = converter.convertBlocksToCells([block]);

    const edit = new WorkspaceEdit();
    edit.set(notebook.uri, [NotebookEdit.insertCells(insertIndex, [cellData])]);

    if (!(await workspace.applyEdit(edit))) {
        throw new Error(`Failed to insert ephemeral ${blockType} cell for agent block ${agentBlockId}`);
    }

    const insertedCell = notebook.getCells().find((c) => getBlockId(c) === block.id);

    if (!insertedCell) {
        throw new Error(`Inserted ephemeral ${blockType} cell ${block.id} not found in notebook`);
    }

    return insertedCell;
}

export const EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface EphemeralCellExecutionResult {
    success: boolean;
    outputs: unknown[];
    executionCount: number | null;
    /** Why the run failed, when the failure wasn't the cell's own output (cancellation, timeout). */
    error?: string;
}

export async function executeEphemeralCell(
    cell: NotebookCell,
    token: CancellationToken
): Promise<EphemeralCellExecutionResult> {
    // Cancel before dispatch — a rejected wait alone still runs the cell in the kernel.
    if (token.isCancellationRequested) {
        throw new CancellationError();
    }

    const completionDeferred = createDeferred<void>();
    const disposables: IDisposable[] = [];

    disposables.push(
        notebookCellExecutions.onDidChangeNotebookCellExecutionState((e) => {
            if (e.cell === cell && e.state === NotebookCellExecutionState.Idle) {
                completionDeferred.resolve();
            }
        })
    );

    disposables.push(token.onCancellationRequested(() => completionDeferred.reject(new CancellationError())));

    const timeout = setTimeout(() => {
        completionDeferred.reject(new Error('Ephemeral cell execution timed out'));
    }, EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS);

    try {
        const cellIndex = cell.index;

        // Race dispatch with Idle wait — command can hang while the cell is still running.
        await Promise.all([
            commands.executeCommand('notebook.cell.execute', {
                ranges: [{ start: cellIndex, end: cellIndex + 1 }],
                document: cell.notebook.uri
            }),
            completionDeferred.promise
        ]);

        return {
            success: cell.executionSummary?.success === true,
            outputs: cell.outputs.map(translateCellDisplayOutput),
            executionCount: cell.executionSummary?.executionOrder ?? null
        };
    } catch (error) {
        if (error instanceof CancellationError) {
            throw error;
        }

        // Surface timeout/cancel reason — "(no output)" makes the agent retry while the cell still runs.
        return {
            success: false,
            outputs: [],
            executionCount: null,
            error: error instanceof Error ? error.message : String(error)
        };
    } finally {
        dispose(disposables);
        clearTimeout(timeout);
    }
}

/**
 * Removes prior-run scratch cells owned by agents in `cells` and returns the batch without them.
 * Required before `executeAgentCell` — otherwise stale generated code would run. Only agents in
 * `cells` are scoped so standalone ephemeral runs stay untouched.
 *
 * A rejected delete-edit is propagated so leftover scratch cannot stay in the batch and re-run.
 */
export async function removeEphemeralCellsForAgentBlocks(
    notebook: NotebookDocument,
    cells: NotebookCell[]
): Promise<NotebookCell[]> {
    const agentBlockIds = new Set(
        cells
            .filter(isAgentCell)
            .map(getBlockId)
            .filter((id) => id != null)
    );

    if (agentBlockIds.size === 0) {
        return cells;
    }

    const deletedCells = await removeEphemeralCellsOwnedBy(notebook, agentBlockIds);

    return cells.filter((cell) => !deletedCells.has(cell));
}
