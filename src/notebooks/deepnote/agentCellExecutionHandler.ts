import {
    CancellationError,
    CancellationToken,
    NotebookCell,
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookController,
    NotebookDocument,
    NotebookEdit,
    NotebookRange,
    WorkspaceEdit,
    commands,
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
import type { IDisposable } from '../../platform/common/types';
import { createDeferred } from '../../platform/common/utils/async';
import { dispose } from '../../platform/common/utils/lifecycle';
import { uuidUtils } from '../../platform/common/uuid';
import { ServiceContainer } from '../../platform/ioc/container';
import { logger } from '../../platform/logging';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { IDeepnoteNotebookManager } from '../types';
import { generateBlockId, generateSortingKey, isEphemeralCell } from './dataConversionUtils';
import { DeepnoteDataConverter } from './deepnoteDataConverter';
import { getOrPromptOpenAiApiKey } from './deepnoteSecretStore';

/**
 * Project-level MCP servers and database integrations declared in the `.deepnote` file, matching what
 * the CLI's ExecutionEngine passes. `executeAgentBlock` merges the servers with any block-level
 * `deepnote_mcp_servers` (block wins on name), and only names the integrations — along with the
 * `dntk.execute_sql` instructions — in its system prompt when that list is non-empty, so leaving
 * either empty silently drops the project-level half of that contract.
 *
 * Spawning MCP servers is arbitrary local command execution declared by a workspace file, so every
 * caller must already be behind a `workspace.isTrusted` check.
 */
function getProjectAgentContext(notebook: NotebookDocument): Pick<AgentBlockContext, 'mcpServers' | 'integrations'> {
    const projectId = notebook.metadata?.deepnoteProjectId as string | undefined;
    const notebookId = notebook.metadata?.deepnoteNotebookId as string | undefined;

    if (!projectId || !notebookId) {
        return { mcpServers: [] };
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

// Tool results reported back to the agent. These mirror the wording @deepnote/runtime-core uses in
// its own ExecutionEngine implementation of the same tools, so the agent sees identical phrasing
// whether a block runs in the extension or on the backend.
const MARKDOWN_BLOCK_ADDED_TEXT = 'Markdown block added.';
const NO_OUTPUT_TEXT = '(no output)';

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
            const block = converter.convertCellToBlock(
                {
                    kind: cell.kind,
                    value: cell.document.getText(),
                    languageId: cell.document.languageId,
                    metadata: cell.metadata,
                    outputs: [...(cell.outputs || [])]
                },
                cell.index
            );
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

/**
 * `translateCellDisplayOutput` follows nbformat's multiline convention and emits text as an array of
 * lines — both for stream `text` and for the `text/*` entries of `execute_result`/`display_data`
 * `data`. `extractOutputsText` reads stream text only when it is a string, and stringifies
 * `data['text/plain']` with `String(...)`, which joins an array with commas. Join the lines first so
 * `print()` output isn't dropped and a `df.head()` string representation doesn't reach the agent with a
 * comma glued to the start of every line.
 */
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

export async function executeAgentCell(
    cell: NotebookCell,
    controller: NotebookController,
    options?: ExecuteAgentCellOptions
): Promise<void> {
    const executeAgentBlockFn = options?.executeAgentBlockFn ?? executeAgentBlock;
    const execution = controller.createNotebookCellExecution(cell);
    execution.start(Date.now());

    try {
        await execution.clearOutput();

        const prompt = cell.document.getText();

        // Streamed as stdout items so each event can be appended rather than re-sending the whole
        // transcript: `NotebookCellOutputItem.text` re-encodes the full buffer on every token, which
        // is O(n²) bytes across the extension-host boundary — and since runtime-core awaits
        // `onAgentEvent` inside its stream loop, that cost is added to the run's wall clock.
        // The stdout mime is the one the renderer concatenates, matching how kernel output streams.
        const output = new NotebookCellOutput([NotebookCellOutputItem.stdout(`[Agent] Planning next steps...`)]);
        await execution.replaceOutput([output]);

        const dataConverter = new DeepnoteDataConverter();
        const deepnoteBlock = dataConverter.convertCellToBlock(
            {
                kind: cell.kind,
                value: cell.document.getText(),
                languageId: cell.document.languageId,
                metadata: cell.metadata,
                outputs: [...(cell.outputs || [])]
            },
            cell.index
        );
        const agentBlock: AgentBlock | null = deepnoteBlock.type === 'agent' ? deepnoteBlock : null;

        if (agentBlock == null) {
            // TODO: better DX error handling
            throw new Error('Cell is not an agent cell');
        }

        // Acquire the key before the destructive cleanup below: it prompts, and throws when the user
        // dismisses the prompt, which would otherwise leave the previous run's cells already deleted.
        const openAiToken = await getOrPromptOpenAiApiKey();

        await removeEphemeralCellsForAgent(cell.notebook, agentBlock.id);

        let lastAgentEventType: AgentStreamEvent['type'] | undefined;

        // Must run after the removal — serializeNotebookContextFromBlocks does no ephemeral
        // filtering, so the agent would otherwise be handed its own previous scratch cells.
        const notebookContext = serializeNotebookContext({
            cells: cell.notebook.getCells().filter((c) => c.index !== cell.index),
            notebookName: (cell.notebook.metadata?.deepnoteNotebookName as string | undefined) ?? ''
        });

        const context: AgentBlockContext = {
            openAiToken,
            ...getProjectAgentContext(cell.notebook),
            notebookContext,
            addMarkdownBlock: async ({ content }: { content: string }) => {
                try {
                    await insertEphemeralCell(cell.notebook, cell.index, agentBlock.id, 'markdown', content);

                    return MARKDOWN_BLOCK_ADDED_TEXT;
                } catch (error) {
                    const insertError = error instanceof Error ? error : new Error(String(error));

                    return `Failed to add markdown block: ${insertError.message}`;
                }
            },
            addAndExecuteCodeBlock: async ({ code }: { code: string }) => {
                try {
                    const insertedCell = await insertEphemeralCell(
                        cell.notebook,
                        cell.index,
                        agentBlock.id,
                        'code',
                        code
                    );

                    const { success, outputs, error } = await executeEphemeralCell(insertedCell, execution.token);
                    const outputText = error ?? describeExecutionOutputs(outputs);

                    return success ? `Output:\n${outputText}` : `Execution failed:\n${outputText}`;
                } catch (error) {
                    const executionError = error instanceof Error ? error : new Error(String(error));

                    return `Execution error: ${executionError.message}`;
                }
            },
            onAgentEvent: async (event: AgentStreamEvent) => {
                logger.trace(`Agent event: ${event.type}`);

                let delta = lastAgentEventType != null && lastAgentEventType !== event.type ? `\n\n` : '';

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

        execution.end(true, Date.now());
    } catch (error) {
        // `logger.error(msg, error)` only renders `Error.prototype.toString()` unless the error is
        // branded with `isJupyterError`, so the stack has to be logged explicitly.
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
        execution.end(false, Date.now());
    }
}

function getInsertIndexAfterAgentCell(
    notebook: NotebookDocument,
    agentCellIndex: number,
    agentBlockId: string
): number {
    let index = agentCellIndex + 1;

    while (index < notebook.cellCount) {
        const cell = notebook.cellAt(index);
        if (isEphemeralCell(cell) && cell.metadata?.agent_source_block_id === agentBlockId) {
            index++;
        } else {
            break;
        }
    }

    return index;
}

/**
 * Inserts an ephemeral cell after the agent cell and returns the cell that was actually created.
 *
 * Resolving by block id rather than by index matters: `cellAt` clamps out-of-range indices instead of
 * throwing, so a rejected edit or a concurrent structural change would otherwise hand the caller a
 * pre-existing user cell — which `addAndExecuteCodeBlock` would then run.
 */
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

    // The converter mirrors the block id into `__deepnoteBlockId` precisely because VS Code may
    // rewrite `id`, so match on that.
    const insertedCell = notebook.getCells().find((c) => c.metadata?.__deepnoteBlockId === block.id);

    if (!insertedCell) {
        throw new Error(`Inserted ephemeral ${blockType} cell ${block.id} not found in notebook`);
    }

    return insertedCell;
}

const EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface EphemeralCellExecutionResult {
    success: boolean;
    outputs: unknown[];
    executionCount: number | null;
    /** Why the run failed, when the failure wasn't the cell's own output (cancellation, timeout). */
    error?: string;
}

export async function executeEphemeralCell(
    cell: NotebookCell,
    token?: CancellationToken
): Promise<EphemeralCellExecutionResult> {
    // Bail before dispatching: rejecting the deferred alone would abandon the wait but still hand the
    // generated code to the kernel.
    if (token?.isCancellationRequested) {
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

    if (token) {
        disposables.push(token.onCancellationRequested(() => completionDeferred.reject(new CancellationError())));
    }

    const timeout = setTimeout(() => {
        completionDeferred.reject(new Error('Ephemeral cell execution timed out'));
    }, EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS);

    try {
        const cellIndex = cell.index;

        // The dispatch settles independently of the cell reaching Idle, so both waits have to start
        // together — otherwise the timeout cannot end a run whose command never resolves, and a
        // rejection arriving before the second await is reported as unhandled.
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

        // Report the reason rather than collapsing everything into "(no output)" — a timed-out cell
        // is still running, and telling the agent it produced nothing invites an immediate retry.
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

async function removeEphemeralCellsForAgent(notebook: NotebookDocument, agentBlockId: string): Promise<void> {
    const deletions: NotebookEdit[] = [];

    for (let i = notebook.cellCount - 1; i >= 0; i--) {
        const cell = notebook.cellAt(i);

        if (isEphemeralCell(cell) && cell.metadata?.agent_source_block_id === agentBlockId) {
            deletions.push(NotebookEdit.deleteCells(new NotebookRange(i, i + 1)));
        }
    }

    if (deletions.length === 0) {
        return;
    }

    const edit = new WorkspaceEdit();
    edit.set(notebook.uri, deletions);

    // Fatal rather than a warning: the notebook context the agent receives is read off the live
    // document, and Run All keeps these cells out of its kernel batch only by their index going
    // negative once they are deleted.
    if (!(await workspace.applyEdit(edit))) {
        throw new Error(`Failed to remove ephemeral cells for agent block ${agentBlockId}`);
    }

    logger.info(`Removed ${deletions.length} ephemeral cell(s) for agent block ${agentBlockId}`);
}
