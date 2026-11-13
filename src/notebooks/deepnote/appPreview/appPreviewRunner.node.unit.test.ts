import { isExecutableBlock, isInputBlock, type DeepnoteBlock, type DeepnoteFile } from '@deepnote/blocks';
import type { BlockExecutionResult, ExecutionOptions, ExecutionSummary } from '@deepnote/runtime-core';
import { assert } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, instance, mock, when } from 'ts-mockito';
import { CancellationError, CancellationTokenSource, Uri } from 'vscode';

import {
    DeepnoteToolkitDependencyResponse,
    type DeepnoteServerInfo,
    type IDeepnoteServerStarter,
    type IDeepnoteToolkitDependencyService
} from '../../../kernels/deepnote/types';
import type { DeepnoteNotebook } from '../../../platform/deepnote/deepnoteTypes';
import type { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import * as path from '../../../platform/vscode-path/path';
import {
    __getExecutionEngines,
    __resetRuntimeCoreMock,
    __setExecutionEngineBehavior
} from '../../../test/mocks/deepnoteRuntimeCore';
import { stubWorkspaceFsOnDisk } from '../../../test/mocks/vscodeFs';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import type { IDeepnoteNotebookInterpreters } from '../deepnoteNotebookInterpreters';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject,
    DEEPNOTE_CLOUD_INIT_BLOCK,
    WINDOWS_INIT_BLOCK
} from '../deepnoteTestHelpers';
import { AppPreviewRunner } from './appPreviewRunner.node';
import type { AppPreviewRunRequest } from './types';

const INTERPRETER: PythonEnvironment = { id: 'venv', uri: Uri.file('/venv/bin/python') };
const SERVER = { url: 'http://127.0.0.1:8888', jupyterPort: 8888, lspPort: 8889 } as DeepnoteServerInfo;

type BlockResult = Partial<Pick<BlockExecutionResult, 'success' | 'outputs' | 'error'>>;

function textInput(id: string, name: string, value: string, sortingKey = 'a0'): DeepnoteBlock {
    return {
        id,
        type: 'input-text',
        blockGroup: 'g',
        sortingKey,
        metadata: { deepnote_variable_name: name, deepnote_variable_value: value }
    };
}

function notebookOf(id: string, blocks: DeepnoteBlock[]): DeepnoteNotebook {
    return createDeepnoteNotebook({ id, name: id, blocks });
}

function projectFile(notebooks: DeepnoteNotebook[], initNotebookId?: string): DeepnoteFile {
    return createDeepnoteFile({
        project: createDeepnoteProject({ id: 'project-1', notebooks, ...(initNotebookId ? { initNotebookId } : {}) })
    });
}

/** The order runtime-core 0.8.0 runs a file's blocks in. */
function executionOrder(file: DeepnoteFile): DeepnoteBlock[] {
    return file.project.notebooks.flatMap((notebook) =>
        [...notebook.blocks]
            .sort((a, b) => a.sortingKey.localeCompare(b.sortingKey))
            .filter((block) => isExecutableBlock(block))
    );
}

/**
 * A `runProject` that behaves like runtime-core 0.8.0's: it writes the inputs into the file's input blocks in place
 * and stops at the first failure.
 */
function runtimeCoreLike(results: Record<string, BlockResult> = {}) {
    return async (file: DeepnoteFile, options: ExecutionOptions): Promise<ExecutionSummary> => {
        for (const block of file.project.notebooks.flatMap((notebook) => notebook.blocks)) {
            const name = isInputBlock(block) ? block.metadata.deepnote_variable_name : undefined;
            if (isInputBlock(block) && name !== undefined && options.inputs && name in options.inputs) {
                block.metadata.deepnote_variable_value = options.inputs[name] as string;
            }
        }

        const blocks = executionOrder(file);
        let executedBlocks = 0;
        for (const block of blocks) {
            const result: BlockExecutionResult = {
                blockId: block.id,
                blockType: block.type,
                success: true,
                outputs: [],
                executionCount: null,
                durationMs: 1,
                ...results[block.id]
            };
            await options.onBlockDone?.(result);
            executedBlocks++;
            if (!result.success) {
                return { totalBlocks: blocks.length, executedBlocks, failedBlocks: 1, totalDurationMs: 1 };
            }
        }

        return { totalBlocks: blocks.length, executedBlocks, failedBlocks: 0, totalDurationMs: 1 };
    };
}

/** A run whose block executes until the engine is stopped, then fails as runtime-core reports it. */
function failWhenStopped(blockId: string) {
    return async (
        _file: DeepnoteFile,
        options: ExecutionOptions,
        stopped: Promise<void>
    ): Promise<ExecutionSummary> => {
        await stopped;
        await options.onBlockDone?.({
            blockId,
            blockType: 'code',
            success: false,
            outputs: [],
            executionCount: null,
            durationMs: 1,
            error: new Error('Kernel client disconnected while an execution was in flight.')
        });

        return { totalBlocks: 1, executedBlocks: 1, failedBlocks: 1, totalDurationMs: 1 };
    };
}

function notebookIdsPerCall(): string[][] {
    return engine().runProjectCalls.map((runCall) => runCall.file.project.notebooks.map((notebook) => notebook.id));
}

function engine() {
    const engines = __getExecutionEngines();
    assert.strictEqual(engines.length, 1, 'the run should create exactly one engine');

    return engines[0];
}

suite('AppPreviewRunner', () => {
    let tmp: string;
    let steps: string[];
    let interpreters: IDeepnoteNotebookInterpreters;
    let toolkit: IDeepnoteToolkitDependencyService;
    let serverStarter: IDeepnoteServerStarter;
    let cancellation: CancellationTokenSource;
    let runner: AppPreviewRunner;

    function write(name: string, file: DeepnoteFile): Uri {
        const fileUri = Uri.file(path.join(tmp, name));
        // JSON is YAML, and keeps the sorting keys, which the `.deepnote` serializer would rewrite.
        fs.writeFileSync(fileUri.fsPath, JSON.stringify(file));

        return fileUri;
    }

    function run(fileUri: Uri, notebookId: string, inputs: AppPreviewRunRequest['inputs'] = {}) {
        return runner.run({ fileUri, notebookId, inputs }, cancellation.token, () => steps.push('running'));
    }

    setup(() => {
        resetVSCodeMocks();
        __resetRuntimeCoreMock();
        stubWorkspaceFsOnDisk();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-app-preview-runner-'));
        steps = [];
        cancellation = new CancellationTokenSource();

        when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenCall(async (uri: Uri) => {
            steps.push(`open ${path.basename(uri.fsPath)}`);
        });
        interpreters = mock<IDeepnoteNotebookInterpreters>();
        when(interpreters.resolve(anything())).thenCall(async () => {
            steps.push('resolve');

            return INTERPRETER;
        });
        toolkit = mock<IDeepnoteToolkitDependencyService>();
        when(toolkit.ensureToolkitInstalled(anything(), anything(), anything())).thenCall(async () => {
            steps.push('ensureToolkit');

            return DeepnoteToolkitDependencyResponse.ok;
        });
        serverStarter = mock<IDeepnoteServerStarter>();
        when(serverStarter.startServer(anything(), anything(), anything())).thenCall(async () => {
            steps.push('startServer');

            return SERVER;
        });
        __setExecutionEngineBehavior({
            start: async () => {
                steps.push('start');
            },
            runProject: runtimeCoreLike()
        });

        runner = new AppPreviewRunner(instance(interpreters), instance(serverStarter), instance(toolkit));
    });

    teardown(() => {
        sinon.restore();
        cancellation.dispose();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    suite('what it runs', () => {
        test("opens the file's notebook, then starts a kernel on the file's toolkit server, then runs", async () => {
            const fileUri = write('main.deepnote', projectFile([notebookOf('nb-1', [createDeepnoteBlock()])]));

            await run(fileUri, 'nb-1');

            assert.deepStrictEqual(steps, [
                'open main.deepnote',
                'resolve',
                'ensureToolkit',
                'startServer',
                'start',
                'running'
            ]);
            assert.deepStrictEqual(engine().config, { pythonEnv: '/venv/bin/python', workingDirectory: tmp });
            assert.strictEqual(engine().options?.server, SERVER);
        });

        test('runs the init notebook of the same file first, then the notebook, each on its own', async () => {
            const fileUri = write(
                'main.deepnote',
                projectFile(
                    [
                        notebookOf('nb-other', [createDeepnoteBlock({ id: 'other' })]),
                        notebookOf('nb-1', [createDeepnoteBlock({ id: 'main' })]),
                        notebookOf('nb-init', [createDeepnoteBlock({ id: 'setup' })])
                    ],
                    'nb-init'
                )
            );

            await run(fileUri, 'nb-1');

            assert.deepStrictEqual(notebookIdsPerCall(), [['nb-init'], ['nb-1']]);
        });

        test("gives the project's integrations to the init notebook's run and the notebook's run", async () => {
            const integrations = [{ id: 'pg', name: 'Postgres', type: 'pgsql' }];
            const file = projectFile(
                [notebookOf('nb-1', [createDeepnoteBlock()]), notebookOf('nb-init', [createDeepnoteBlock()])],
                'nb-init'
            );
            const fileUri = write('main.deepnote', { ...file, project: { ...file.project, integrations } });

            await run(fileUri, 'nb-1');

            assert.deepStrictEqual(
                engine().runProjectCalls.map((runCall) => runCall.options.integrations),
                [integrations, integrations]
            );
        });

        test("runs the init notebook from a sibling file of the same project when the file doesn't have it", async () => {
            const fileUri = write(
                'main.deepnote',
                projectFile([notebookOf('nb-1', [createDeepnoteBlock()])], 'nb-init')
            );
            write(
                'init.deepnote',
                projectFile([notebookOf('nb-init', [createDeepnoteBlock({ id: 'setup', content: 'import os' })])])
            );

            await run(fileUri, 'nb-1');

            assert.deepStrictEqual(notebookIdsPerCall(), [['nb-init'], ['nb-1']]);
            assert.deepInclude(engine().runProjectCalls[0].file.project.notebooks[0].blocks[0], {
                id: 'setup',
                content: 'import os'
            });
        });

        const withoutInit: [string, string][] = [
            ['the notebook is the init notebook', 'nb-1'],
            ['no file has the init notebook', 'nb-init']
        ];
        for (const [condition, initNotebookId] of withoutInit) {
            test(`runs only the notebook when ${condition}`, async () => {
                const fileUri = write(
                    'main.deepnote',
                    projectFile([notebookOf('nb-1', [createDeepnoteBlock()])], initNotebookId)
                );

                const outcome = await run(fileUri, 'nb-1');

                assert.strictEqual(outcome.status, 'success');
                assert.deepStrictEqual(notebookIdsPerCall(), [['nb-1']]);
            });
        }

        test("passes the inputs to the notebook's run only, so the init notebook keeps its saved values", async () => {
            const file = projectFile(
                [
                    notebookOf('nb-init', [
                        {
                            id: 'init-x',
                            type: 'input-checkbox',
                            blockGroup: 'g',
                            sortingKey: 'a0',
                            metadata: { deepnote_variable_name: 'x', deepnote_variable_value: false }
                        }
                    ]),
                    notebookOf('nb-1', [textInput('x', 'x', 'saved')])
                ],
                'nb-init'
            );
            const fileUri = write('main.deepnote', file);
            const onDisk = fs.readFileSync(fileUri.fsPath, 'utf8');

            await run(fileUri, 'nb-1', { x: 'hello' });

            const [initCall, notebookCall] = engine().runProjectCalls;
            assert.isUndefined(initCall.options.inputs);
            assert.deepInclude(initCall.file.project.notebooks[0].blocks[0].metadata, {
                deepnote_variable_value: false
            });
            assert.deepStrictEqual(notebookCall.options.inputs, { x: 'hello' });
            assert.strictEqual(fs.readFileSync(fileUri.fsPath, 'utf8'), onDisk);
        });

        test("runs the blocks in Deepnote's sorting key order, which runtime-core's localeCompare would not", async () => {
            const fileUri = write(
                'main.deepnote',
                projectFile([
                    notebookOf('nb-1', [
                        createDeepnoteBlock({ id: 'lower', sortingKey: 'a0' }),
                        createDeepnoteBlock({ id: 'upper', sortingKey: 'Z0j' }),
                        createDeepnoteBlock({ id: 'first', sortingKey: 'V' })
                    ])
                ])
            );

            const outcome = await run(fileUri, 'nb-1');

            assert.deepStrictEqual(
                executionOrder(engine().runProjectCalls[0].file).map((block) => block.id),
                ['first', 'upper', 'lower']
            );
            assert.deepStrictEqual(
                outcome.snapshotBlocks?.map((block) => block.id),
                ['first', 'upper', 'lower']
            );
        });

        test("runs Windows' replacement for Deepnote Cloud's init block on Windows, and leaves the file alone", async () => {
            sinon.stub(process, 'platform').value('win32');
            const fileUri = write(
                'main.deepnote',
                projectFile(
                    [
                        notebookOf('nb-init', [
                            createDeepnoteBlock({ id: 'setup', content: DEEPNOTE_CLOUD_INIT_BLOCK })
                        ]),
                        notebookOf('nb-1', [createDeepnoteBlock({ id: 'main', content: DEEPNOTE_CLOUD_INIT_BLOCK })])
                    ],
                    'nb-init'
                )
            );
            const onDisk = fs.readFileSync(fileUri.fsPath, 'utf8');

            await run(fileUri, 'nb-1');

            const contents = engine().runProjectCalls.map((runCall) =>
                runCall.file.project.notebooks[0].blocks.map((block) => (block.type === 'code' ? block.content : ''))
            );
            assert.deepStrictEqual(contents, [[WINDOWS_INIT_BLOCK], [DEEPNOTE_CLOUD_INIT_BLOCK]]);
            assert.strictEqual(fs.readFileSync(fileUri.fsPath, 'utf8'), onDisk);
        });
    });

    suite('outcomes', () => {
        let fileUri: Uri;

        setup(() => {
            fileUri = write(
                'main.deepnote',
                projectFile([
                    notebookOf('nb-1', [
                        textInput('region', 'region', 'Europe', 'a0'),
                        createDeepnoteBlock({ id: 'chart', sortingKey: 'a1' }),
                        createDeepnoteBlock({ id: 'table', sortingKey: 'a2' }),
                        { id: 'notes', type: 'markdown', blockGroup: 'g', sortingKey: 'a3', content: '', metadata: {} }
                    ])
                ])
            );
        });

        const chartOutput = { output_type: 'display_data', data: { 'application/json': { total: 3 } }, metadata: {} };
        const errorOutput = { output_type: 'error', ename: 'ValueError', evalue: 'no data', traceback: [] };

        test('succeeds with every block of the notebook and its outputs, and stops the kernel', async () => {
            __setExecutionEngineBehavior({ runProject: runtimeCoreLike({ chart: { outputs: [chartOutput] } }) });

            const outcome = await run(fileUri, 'nb-1', { region: 'Asia' });

            assert.deepStrictEqual(outcome, {
                status: 'success',
                error: null,
                snapshotBlocks: [
                    {
                        id: 'region',
                        type: 'input-text',
                        outputs: [],
                        metadata: { deepnote_variable_name: 'region', deepnote_variable_value: 'Asia' },
                        outputHead: null,
                        outputTail: null
                    },
                    {
                        id: 'chart',
                        type: 'code',
                        outputs: [chartOutput],
                        metadata: {},
                        outputHead: null,
                        outputTail: null
                    },
                    { id: 'table', type: 'code', outputs: [], metadata: {}, outputHead: null, outputTail: null },
                    { id: 'notes', type: 'markdown', outputs: [], metadata: {}, outputHead: null, outputTail: null }
                ]
            });
            assert.strictEqual(engine().stopCalls, 1);
        });

        const failures: [string, BlockResult, string][] = [
            ['a Python exception', { success: false, outputs: [errorOutput] }, 'ValueError: no data'],
            [
                'an error running the block',
                { success: false, outputs: [errorOutput], error: new Error('The kernel died') },
                'The kernel died'
            ],
            ['no error', { success: false, outputs: [] }, 'Block table failed.']
        ];
        for (const [condition, tableResult, message] of failures) {
            test(`fails with the block's message for ${condition}, keeping the outputs so far`, async () => {
                __setExecutionEngineBehavior({
                    runProject: runtimeCoreLike({ chart: { outputs: [chartOutput] }, table: tableResult })
                });

                const outcome = await run(fileUri, 'nb-1');

                assert.strictEqual(outcome.status, 'error');
                assert.strictEqual(outcome.error, message);
                assert.deepStrictEqual(
                    outcome.snapshotBlocks?.map((block) => [block.id, block.outputs]),
                    [
                        ['region', []],
                        ['chart', [chartOutput]],
                        ['table', tableResult.outputs],
                        ['notes', []]
                    ]
                );
                assert.strictEqual(engine().stopCalls, 1);
            });
        }

        test('succeeds when only a block an agent added failed, as runtime-core carries on then', async () => {
            __setExecutionEngineBehavior({
                runProject: async (_file, options) => {
                    await options.onBlockDone?.({
                        blockId: 'agent-added',
                        blockType: 'code',
                        success: false,
                        outputs: [errorOutput],
                        executionCount: null,
                        durationMs: 0
                    });

                    return { totalBlocks: 1, executedBlocks: 1, failedBlocks: 0, totalDurationMs: 1 };
                }
            });

            const outcome = await run(fileUri, 'nb-1');

            assert.strictEqual(outcome.status, 'success');
            assert.isNull(outcome.error);
        });

        test('fails with the init block\'s message after "Init notebook failed: ", without running the notebook', async () => {
            const withInit = write(
                'with-init.deepnote',
                projectFile(
                    [
                        notebookOf('nb-init', [createDeepnoteBlock({ id: 'setup' })]),
                        notebookOf('nb-1', [createDeepnoteBlock({ id: 'chart' })])
                    ],
                    'nb-init'
                )
            );
            __setExecutionEngineBehavior({
                runProject: runtimeCoreLike({ setup: { success: false, outputs: [errorOutput] } })
            });

            const outcome = await run(withInit, 'nb-1');

            assert.deepStrictEqual(outcome, {
                status: 'error',
                error: 'Init notebook failed: ValueError: no data',
                snapshotBlocks: [
                    { id: 'chart', type: 'code', outputs: [], metadata: {}, outputHead: null, outputTail: null }
                ]
            });
            assert.deepStrictEqual(notebookIdsPerCall(), [['nb-init']]);
            assert.strictEqual(engine().stopCalls, 1);
        });

        test('is an internal error, without a kernel, when the notebook has no interpreter', async () => {
            when(interpreters.resolve(anything())).thenResolve(undefined);

            const outcome = await run(fileUri, 'nb-1');

            assert.deepStrictEqual(outcome, {
                status: 'internal_error',
                error: 'No Python interpreter is selected for the notebook. Select one in VS Code, then run the app again.',
                snapshotBlocks: null
            });
            assert.deepStrictEqual(__getExecutionEngines(), []);
        });

        const declined = [
            DeepnoteToolkitDependencyResponse.cancel,
            DeepnoteToolkitDependencyResponse.selectDifferentInterpreter,
            DeepnoteToolkitDependencyResponse.failed
        ];
        for (const response of declined) {
            test(`is an internal error, without a server, when the toolkit install answers ${DeepnoteToolkitDependencyResponse[response]}`, async () => {
                when(toolkit.ensureToolkitInstalled(anything(), anything(), anything())).thenResolve(response);

                const outcome = await run(fileUri, 'nb-1');

                assert.deepStrictEqual(outcome, {
                    status: 'internal_error',
                    error: "deepnote-toolkit is not installed in the notebook's Python interpreter. Install it from VS Code, then run the app again.",
                    snapshotBlocks: null
                });
                assert.notInclude(steps, 'startServer');
            });
        }

        test('is an internal error with the message when the server fails to start', async () => {
            when(serverStarter.startServer(anything(), anything(), anything())).thenReject(
                new Error('The server exited')
            );

            const outcome = await run(fileUri, 'nb-1');

            assert.deepStrictEqual(outcome, {
                status: 'internal_error',
                error: 'The server exited',
                snapshotBlocks: null
            });
            assert.deepStrictEqual(__getExecutionEngines(), []);
        });

        const engineFailures: [string, () => void][] = [
            [
                'the kernel fails to start',
                () =>
                    __setExecutionEngineBehavior({
                        start: async () => {
                            throw new Error('The kernel died');
                        }
                    })
            ],
            [
                'running the notebook throws',
                () =>
                    __setExecutionEngineBehavior({
                        runProject: async () => {
                            throw new Error('The kernel died');
                        }
                    })
            ]
        ];
        for (const [condition, arrange] of engineFailures) {
            test(`is an internal error with the message, and stops the kernel, when ${condition}`, async () => {
                arrange();

                const outcome = await run(fileUri, 'nb-1');

                assert.deepStrictEqual(outcome, {
                    status: 'internal_error',
                    error: 'The kernel died',
                    snapshotBlocks: null
                });
                assert.strictEqual(engine().stopCalls, 1);
            });
        }
    });

    suite('cancellation', () => {
        let fileUri: Uri;

        setup(() => {
            fileUri = write('main.deepnote', projectFile([notebookOf('nb-1', [createDeepnoteBlock()])]));
        });

        const stoppedSteps: [string, () => void, string[]][] = [
            [
                'the notebook opens',
                () =>
                    when(mockedVSCodeNamespaces.workspace.openNotebookDocument(anything())).thenCall(async () => {
                        steps.push('open');
                        cancellation.cancel();
                    }),
                ['open']
            ],
            [
                'the interpreter resolves',
                () =>
                    when(interpreters.resolve(anything())).thenCall(async () => {
                        steps.push('resolve');
                        cancellation.cancel();

                        return INTERPRETER;
                    }),
                ['open main.deepnote', 'resolve']
            ],
            [
                'the toolkit install is checked',
                () =>
                    when(toolkit.ensureToolkitInstalled(anything(), anything(), anything())).thenCall(async () => {
                        steps.push('ensureToolkit');
                        cancellation.cancel();

                        return DeepnoteToolkitDependencyResponse.cancel;
                    }),
                ['open main.deepnote', 'resolve', 'ensureToolkit']
            ],
            [
                'the server starts',
                () =>
                    when(serverStarter.startServer(anything(), anything(), anything())).thenCall(async () => {
                        steps.push('startServer');
                        cancellation.cancel();

                        return SERVER;
                    }),
                ['open main.deepnote', 'resolve', 'ensureToolkit', 'startServer']
            ],
            [
                'the server starts, which then throws',
                () =>
                    when(serverStarter.startServer(anything(), anything(), anything())).thenCall(async () => {
                        steps.push('startServer');
                        cancellation.cancel();
                        throw new CancellationError();
                    }),
                ['open main.deepnote', 'resolve', 'ensureToolkit', 'startServer']
            ]
        ];
        for (const [step, arrange, expectedSteps] of stoppedSteps) {
            test(`stops before the next step when cancelled while ${step}`, async () => {
                arrange();

                const outcome = await run(fileUri, 'nb-1');

                assert.deepStrictEqual(outcome, { status: 'stopped', error: null, snapshotBlocks: null });
                assert.deepStrictEqual(steps, expectedSteps);
                assert.deepStrictEqual(__getExecutionEngines(), []);
            });
        }

        test('stops without running, and stops the kernel, when cancelled while the kernel starts', async () => {
            let kernelStarted: () => void = () => undefined;
            __setExecutionEngineBehavior({
                start: () =>
                    new Promise<void>((resolve) => {
                        kernelStarted = resolve;
                    }),
                runProject: runtimeCoreLike()
            });

            const outcome = run(fileUri, 'nb-1');
            await waitFor(() => __getExecutionEngines()[0]?.startCalls === 1);
            cancellation.cancel();
            kernelStarted();

            assert.deepStrictEqual(await outcome, { status: 'stopped', error: null, snapshotBlocks: null });
            assert.deepStrictEqual(engine().runProjectCalls, []);
            assert.strictEqual(engine().stopCalls, 1);
            assert.notInclude(steps, 'running');
        });

        const cancelCounts: [string, number][] = [
            ['once', 1],
            ['twice', 2]
        ];
        for (const [times, count] of cancelCounts) {
            test(`stops the kernel once, and ends stopped, when cancelled ${times} while a block runs`, async () => {
                __setExecutionEngineBehavior({ runProject: failWhenStopped('block-1') });

                const outcome = run(fileUri, 'nb-1');
                await waitFor(() => __getExecutionEngines()[0]?.runProjectCalls.length === 1);
                for (let cancelled = 0; cancelled < count; cancelled++) {
                    cancellation.cancel();
                }
                await waitFor(() => engine().stopCalls > 0);

                assert.deepStrictEqual(await outcome, { status: 'stopped', error: null, snapshotBlocks: null });
                assert.strictEqual(engine().stopCalls, 1);
            });
        }

        test('ends stopped, without running the notebook, when cancelled while the init notebook runs', async () => {
            const withInit = write(
                'with-init.deepnote',
                projectFile(
                    [notebookOf('nb-init', [createDeepnoteBlock({ id: 'setup' })]), notebookOf('nb-1', [])],
                    'nb-init'
                )
            );
            __setExecutionEngineBehavior({ runProject: failWhenStopped('setup') });

            const outcome = run(withInit, 'nb-1');
            await waitFor(() => __getExecutionEngines()[0]?.runProjectCalls.length === 1);
            cancellation.cancel();
            await waitFor(() => engine().stopCalls > 0);

            assert.deepStrictEqual(await outcome, { status: 'stopped', error: null, snapshotBlocks: null });
            assert.deepStrictEqual(notebookIdsPerCall(), [['nb-init']]);
        });

        test('ends stopped when running throws after a cancel', async () => {
            __setExecutionEngineBehavior({
                runProject: async () => {
                    cancellation.cancel();
                    throw new Error('Kernel client disconnected while an execution was in flight.');
                }
            });

            const outcome = await run(fileUri, 'nb-1');

            assert.deepStrictEqual(outcome, { status: 'stopped', error: null, snapshotBlocks: null });
        });
    });
});

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('waitFor timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
