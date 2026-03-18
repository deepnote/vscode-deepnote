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

import { AgentBlock, DeepnoteBlock } from '@deepnote/blocks';
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
import type { Pocket } from '../../platform/deepnote/pocket';
import { logger } from '../../platform/logging';
import { NotebookCellExecutionState, notebookCellExecutions } from '../../platform/notebooks/cellExecutionStateService';
import { generateBlockId, generateSortingKey, isEphemeralCell } from './dataConversionUtils';
import { DeepnoteDataConverter } from './deepnoteDataConverter';

export function isAgentCell(cell: NotebookCell): boolean {
    const pocket = cell.metadata?.__deepnotePocket as Pocket | undefined;

    return pocket?.type === 'agent';
}

export function serializeNotebookContext({ cells }: { cells: NotebookCell[] }): string {
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

    return serializeNotebookContextFromBlocks({ blocks, notebookName: null });
}

export function getOpenAiApiKey(): string {
    const config = workspace.getConfiguration('deepnote');
    const key = config.get<string>('agent.openAiApiKey', '');

    if (!key) {
        throw new Error('deepnote.agent.openAiApiKey is not set. Configure it in VS Code settings.');
    }

    return key;
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

        let accumulated = `[Agent] Planning next steps...`;
        const output = new NotebookCellOutput([NotebookCellOutputItem.text(accumulated)]);
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

        await removeEphemeralCellsForAgent(cell.notebook, agentBlock.id);

        let lastAgentEventType: AgentStreamEvent['type'] | undefined;

        const notebookContext = serializeNotebookContext({
            cells: cell.notebook.getCells().filter((c) => c.index !== cell.index)
        });

        const openAiToken = getOpenAiApiKey();

        const context: AgentBlockContext = {
            openAiToken,
            mcpServers: [],
            notebookContext,
            addMarkdownBlock: async ({ content }: { content: string }) => {
                await insertEphemeralCell(cell.notebook, cell.index, agentBlock.id, 'markdown', content);
                return { success: true };
            },
            addAndExecuteCodeBlock: async ({ code }: { code: string }) => {
                const cellIndex = await insertEphemeralCell(cell.notebook, cell.index, agentBlock.id, 'code', code);
                const insertedCell = cell.notebook.cellAt(cellIndex);

                const { success } = await executeEphemeralCell(insertedCell, execution.token);
                return success ? { success } : { success: false, error: new Error('Ephemeral cell execution failed') };
            },
            onLog: (message: string) => {
                logger.info('Agent log', message);
                // accumulated += message;
                // TODO: replaceOutputItems is Async function
                // execution.replaceOutputItems(NotebookCellOutputItem.text(accumulated), output);
            },
            onAgentEvent: async (event: AgentStreamEvent) => {
                logger.info('Agent event', JSON.stringify(event));
                if (lastAgentEventType != null && lastAgentEventType !== event.type) {
                    accumulated += `\n\n`;
                }
                switch (event.type) {
                    case 'tool_called':
                        // Ignore calling tool_called events
                        accumulated += `[Agent] Tool called: ${event.toolName}`;
                        break;
                    case 'tool_output':
                        accumulated += `[Agent] Tool output: ${event.toolName}\n`;
                        accumulated += `[Agent] Tool output length: ${event.output?.length}`;
                        break;
                    case 'text_delta':
                        if (lastAgentEventType !== 'text_delta') {
                            accumulated += `[Agent] Text:\n`;
                        }
                        accumulated += event.text;
                        break;
                    case 'reasoning_delta':
                        if (lastAgentEventType !== 'reasoning_delta') {
                            accumulated += `[Agent] Reasoning:\n`;
                        }
                        accumulated += event.text;
                        break;
                    default:
                        event satisfies never;
                }
                lastAgentEventType = event.type;

                await execution.replaceOutputItems(NotebookCellOutputItem.text(accumulated), output);
            }
        };

        logger.info(
            `Agent cell: starting executeAgentBlock, model=${agentBlock.metadata.deepnote_agent_model}, prompt length=${prompt.length}`
        );
        const result = await executeAgentBlockFn(agentBlock, context);
        logger.info(`Agent cell: executeAgentBlock completed, finalOutput length=${result.finalOutput.length}`);

        execution.end(true, Date.now());
    } catch (error) {
        logger.error('Agent cell execution failed', error);
        if (error instanceof Error) {
            logger.error(`Agent error name=${error.name}, message=${error.message}`);
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

async function insertEphemeralCell(
    notebook: NotebookDocument,
    agentCellIndex: number,
    agentBlockId: string,
    blockType: 'code' | 'markdown',
    content: string
): Promise<number> {
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
    await workspace.applyEdit(edit);

    return insertIndex;
}

const EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

export async function executeEphemeralCell(
    cell: NotebookCell,
    token?: CancellationToken
): Promise<{ success: boolean; outputs: unknown[]; executionCount: number | null }> {
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
        if (token.isCancellationRequested) {
            completionDeferred.reject(new CancellationError());
        } else {
            disposables.push(token.onCancellationRequested(() => completionDeferred.reject(new CancellationError())));
        }
    }

    const timeout = setTimeout(() => {
        completionDeferred.reject(new Error('Ephemeral cell execution timed out'));
    }, EPHEMERAL_CELL_EXECUTION_TIMEOUT_MS);

    try {
        const cellIndex = cell.index;

        await commands.executeCommand('notebook.cell.execute', {
            ranges: [{ start: cellIndex, end: cellIndex + 1 }],
            document: cell.notebook.uri
        });

        await completionDeferred.promise;

        return {
            success: cell.executionSummary?.success === true,
            outputs: cell.outputs.map(translateCellDisplayOutput),
            executionCount: cell.executionSummary?.executionOrder ?? null
        };
    } catch (error) {
        return {
            success: false,
            outputs: [],
            executionCount: null
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

    const success = await workspace.applyEdit(edit);
    if (success) {
        logger.info(`Removed ${deletions.length} ephemeral cell(s) for agent block ${agentBlockId}`);
    } else {
        logger.warn(`Failed to remove ephemeral cells for agent block ${agentBlockId}`);
    }
}
