import type { DeepnoteBlock, DeepnoteFile } from '@deepnote/blocks';
import type { IDisplayData, IOutput, IStream } from '@deepnote/runtime-core';
import { assert } from 'chai';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as sinon from 'sinon';
import { anything, capture, instance, mock, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';
import zlib from 'zlib';

import { createDeferred, type Deferred } from '../../../platform/common/utils/async';
import { DeepnoteAppPreview } from '../../../platform/common/utils/localize';
import { platformUtils } from '../../../platform/common/utils/platform.node';
import { isUUID } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import * as path from '../../../platform/vscode-path/path';
import { EXTENSION_ROOT_DIR_FOR_TESTS } from '../../../test/constants.node';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject
} from '../deepnoteTestHelpers';
import {
    createAppPreviewApi,
    INTERNAL_ERROR_MESSAGE,
    NO_JSON_OUTPUT_MESSAGE,
    NO_RUN_RESULTS_MESSAGE,
    NOT_AVAILABLE_MESSAGE,
    NOTEBOOK_NOT_FOUND_MESSAGE,
    PREVIEW_STOPPED_MESSAGE,
    RUN_NOT_FOUND_MESSAGE,
    UNAUTHORIZED_MESSAGE
} from './appPreviewApi.node';
import { AppPreviewRunFiles } from './appPreviewRunFiles.node';
import type { AppPreviewProject } from './appPreviewSession.node';
import type { WorkspaceNotebook } from './appPreviewWorkspace.node';
import { DATAFRAME_NOT_FOUND_MESSAGE } from './storedDataframePage.node';
import type { AppPreviewApi, AppPreviewRunOutcome, IAppPreviewRunner, SnapshotBlock } from './types';

const TOKEN = 'preview-token';
const SALES_FILE_URI = Uri.file('/workspace/sales.deepnote');
const NOW = '2026-01-02T03:04:05.000Z';

const SALES_FILE = createDeepnoteFile({
    metadata: { createdAt: '2025-03-04T05:06:07.000Z' },
    project: createDeepnoteProject({
        id: 'project-1',
        initNotebookId: 'nb-init',
        notebooks: [
            createDeepnoteNotebook({
                id: 'nb-init',
                name: 'Init',
                blocks: [createDeepnoteBlock({ id: 'setup', sortingKey: 'a0' })]
            }),
            createDeepnoteNotebook({
                id: 'nb-1',
                name: 'Sales',
                blocks: [
                    createDeepnoteBlock({ id: 'chart', sortingKey: 'a1' }),
                    {
                        id: 'region',
                        type: 'input-text',
                        blockGroup: 'g',
                        sortingKey: 'Z',
                        metadata: {
                            deepnote_variable_name: 'region',
                            deepnote_variable_value: 'Europe',
                            deepnote_input_label: 'Region'
                        }
                    }
                ]
            }),
            createDeepnoteNotebook({
                id: 'nb-limits',
                name: 'Limits',
                blocks: [
                    {
                        id: 'limit',
                        type: 'input-text',
                        blockGroup: 'g',
                        sortingKey: 'a0',
                        metadata: { deepnote_variable_name: 'limit', deepnote_variable_value: '5' }
                    }
                ]
            })
        ]
    })
});

const CHART_SNAPSHOT: SnapshotBlock[] = [
    {
        id: 'chart',
        type: 'code',
        outputs: [{ output_type: 'display_data', data: { 'application/json': { total: 3 } }, metadata: {} }],
        metadata: {},
        outputHead: null,
        outputTail: null
    }
];

const RUN_FILE = createDeepnoteFile({
    project: createDeepnoteProject({
        notebooks: [
            createDeepnoteNotebook({
                id: 'nb-1',
                blocks: [createDeepnoteBlock({ id: 'chart', sortingKey: 'a1', outputs: CHART_SNAPSHOT[0].outputs })]
            })
        ]
    })
});

function codeBlock(id: string, outputs: IOutput[]): DeepnoteBlock {
    return createDeepnoteBlock({ id, sortingKey: id, outputs });
}

function agentBlock(id: string, outputs: IOutput[]): DeepnoteBlock {
    return {
        id,
        type: 'agent',
        blockGroup: 'g',
        sortingKey: id,
        content: '',
        metadata: { deepnote_agent_model: 'auto' },
        outputs
    };
}

function display(data: IDisplayData['data']): IDisplayData {
    return { output_type: 'display_data', data, metadata: {} };
}

function stdout(text: string): IStream {
    return { output_type: 'stream', name: 'stdout', text };
}

suite('createAppPreviewApi', () => {
    let server: http.Server;
    let baseUrl: string;
    let api: AppPreviewApi;
    let runner: IAppPreviewRunner;
    let runFiles: AppPreviewRunFiles;
    let findNotebook: sinon.SinonStub<[string], Promise<WorkspaceNotebook | undefined>>;
    let getProject: sinon.SinonStub<[], AppPreviewProject | undefined>;

    setup(async () => {
        runner = mock<IAppPreviewRunner>();
        when(runner.run(anything(), anything(), anything())).thenReturn(createDeferred<AppPreviewRunOutcome>().promise);
        const notebooks = new Map<string, WorkspaceNotebook>(
            SALES_FILE.project.notebooks.map((notebook) => [
                notebook.id,
                { file: SALES_FILE, fileUri: SALES_FILE_URI, notebook }
            ])
        );
        findNotebook = sinon
            .stub<[string], Promise<WorkspaceNotebook | undefined>>()
            .callsFake(async (notebookId) => notebooks.get(notebookId));
        getProject = sinon.stub<[], AppPreviewProject | undefined>();
        runFiles = mock(AppPreviewRunFiles);
        when(runFiles.write(anything(), anything())).thenResolve(true);
        when(runFiles.read(anything())).thenResolve(RUN_FILE);
        when(runFiles.updateLatest(anything(), anything(), anything())).thenResolve();
        when(runFiles.readLatest(anything())).thenResolve(undefined);
        api = createAppPreviewApi({
            token: TOKEN,
            findNotebook,
            getProject,
            runFiles: instance(runFiles),
            runner: instance(runner)
        });
        const app = express();
        app.use('/v2', api.router);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
    });

    teardown(() => {
        sinon.restore();
        api.dispose();
        server.closeAllConnections();
        server.close();
    });

    function call(method: string, path: string, authorization: string | null = `Bearer ${TOKEN}`): Promise<Response> {
        return fetch(`${baseUrl}${path}`, { method, headers: authorization == null ? {} : { authorization } });
    }

    function createRun(body: unknown): Promise<Response> {
        return fetch(`${baseUrl}/runs`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    async function getRun(runId: string): Promise<Record<string, unknown>> {
        const response = await call('GET', `/runs/${runId}`);
        assert.strictEqual(response.status, 200);

        return (await response.json()).run;
    }

    async function waitForStatus(runId: string, status: string): Promise<Record<string, unknown>> {
        const deadline = Date.now() + 2_000;
        for (;;) {
            const run = await getRun(runId);
            if (run.status === status || Date.now() > deadline) {
                assert.strictEqual(run.status, status);

                return run;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }

    async function startRun(): Promise<{ runId: string; outcome: Deferred<AppPreviewRunOutcome> }> {
        const outcome = createDeferred<AppPreviewRunOutcome>();
        when(runner.run(anything(), anything(), anything())).thenReturn(outcome.promise);
        const response = await createRun({ notebookId: 'nb-1' });
        assert.strictEqual(response.status, 202);

        return { runId: (await response.json()).runId, outcome };
    }

    async function finishRun(status: 'success' | 'error'): Promise<string> {
        const { runId, outcome } = await startRun();
        outcome.resolve({ status, error: null, file: RUN_FILE });
        await waitForStatus(runId, status);

        return runId;
    }

    async function assertJson(response: Response, status: number, body: unknown): Promise<void> {
        assert.strictEqual(response.status, status);
        assert.isNull(response.headers.get('access-control-allow-origin'));
        assert.deepStrictEqual(await response.json(), body);
    }

    test("GET /notebooks/:notebookId answers the workspace notebook with its inputs, in Deepnote's shape", async () => {
        await assertJson(await call('GET', '/notebooks/nb-1'), 200, {
            notebook: {
                id: 'nb-1',
                projectId: 'project-1',
                name: 'Sales',
                createdAt: '2025-03-04T05:06:07.000Z',
                isInit: false,
                isScheduled: false,
                lastRunAt: null,
                lastRunId: null,
                inputs: [{ blockId: 'region', name: 'region', type: 'input-text', value: 'Europe', label: 'Region' }],
                blocks: [
                    { id: 'region', type: 'input-text' },
                    { id: 'chart', type: 'code' }
                ]
            }
        });
    });

    test('GET /notebooks/:notebookId leaves inputs out for a notebook without any, and marks the init notebook', async () => {
        await assertJson(await call('GET', '/notebooks/nb-init'), 200, {
            notebook: {
                id: 'nb-init',
                projectId: 'project-1',
                name: 'Init',
                createdAt: '2025-03-04T05:06:07.000Z',
                isInit: true,
                isScheduled: false,
                lastRunAt: null,
                lastRunId: null,
                blocks: [{ id: 'setup', type: 'code' }]
            }
        });
    });

    test('GET /notebooks/:notebookId answers 404 for an ID no workspace notebook has', async () => {
        await assertJson(await call('GET', '/notebooks/nb-missing'), 404, { message: NOTEBOOK_NOT_FOUND_MESSAGE });
    });

    test('answers a JSON 500 without the stack, and logs the error, when the notebook lookup fails', async () => {
        const logError = sinon.stub(logger, 'error');
        const lookupFailure = new Error('findFiles failed in /home/user/project');
        findNotebook.rejects(lookupFailure);

        await assertJson(await call('GET', '/notebooks/nb-1'), 500, { message: INTERNAL_ERROR_MESSAGE });
        assert.deepStrictEqual(
            logError.getCalls().map((logged) => logged.args[1]),
            [lookupFailure]
        );
    });

    test('POST /runs starts a run of the notebook with the inputs, and answers 202 with it pending', async () => {
        sinon.useFakeTimers({ now: Date.parse(NOW), toFake: ['Date'] });

        const response = await createRun({
            notebookId: 'nb-1',
            inputs: { region: 'Asia' },
            detachedRunStorageMode: 'readonly'
        });

        assert.strictEqual(response.status, 202);
        const body = await response.json();
        assert.isTrue(isUUID(body.runId), `${body.runId} is not a UUID`);
        assert.deepStrictEqual(body, { runId: body.runId, status: 'pending', createdAt: NOW });
        verify(runner.run(anything(), anything(), anything())).once();
        assert.deepStrictEqual(capture(runner.run).last()[0], {
            createdAt: NOW,
            file: SALES_FILE,
            fileUri: SALES_FILE_URI,
            notebookId: 'nb-1',
            inputs: { region: 'Asia' }
        });
    });

    test('POST /runs runs the notebook without inputs when the body has none', async () => {
        sinon.useFakeTimers({ now: Date.parse(NOW), toFake: ['Date'] });

        assert.strictEqual((await createRun({ notebookId: 'nb-init' })).status, 202);

        verify(runner.run(anything(), anything(), anything())).once();
        assert.deepStrictEqual(capture(runner.run).last()[0], {
            createdAt: NOW,
            file: SALES_FILE,
            fileUri: SALES_FILE_URI,
            notebookId: 'nb-init',
            inputs: {}
        });
    });

    test("GET /runs/:runId reports the run as pending, running, and then finished, in Deepnote's shape", async () => {
        const clock = sinon.useFakeTimers({ now: Date.parse(NOW), toFake: ['Date'] });
        const { runId, outcome } = await startRun();
        when(runFiles.read(anything())).thenReject(new Error('Not the file of this run'));
        when(runFiles.read(runId)).thenResolve(RUN_FILE);
        const pending = {
            runId,
            notebookId: 'nb-1',
            status: 'pending',
            snapshotStatus: 'pending',
            snapshotExpiresAt: null,
            snapshotContent: null,
            snapshotDownloadUrl: null,
            snapshotBlocks: null,
            error: null,
            createdAt: NOW,
            completedAt: null
        };
        assert.deepStrictEqual(await getRun(runId), pending);

        const [, , onRunning] = capture(runner.run).last();
        onRunning();
        assert.deepStrictEqual(await getRun(runId), { ...pending, status: 'running' });

        clock.tick(65_000);
        outcome.resolve({ status: 'success', error: null, file: RUN_FILE });
        assert.deepStrictEqual(await waitForStatus(runId, 'success'), {
            ...pending,
            status: 'success',
            snapshotStatus: 'available',
            snapshotBlocks: CHART_SNAPSHOT,
            completedAt: '2026-01-02T03:05:10.000Z'
        });
        verify(runFiles.write(runId, RUN_FILE)).once();
        verify(runFiles.updateLatest('nb-1', runId, NOW)).once();
    });

    const outcomes: [AppPreviewRunOutcome, string, SnapshotBlock[] | null, number][] = [
        [{ status: 'error', error: 'ValueError: no data', file: RUN_FILE }, 'available', CHART_SNAPSHOT, 1],
        [{ status: 'internal_error', error: 'The kernel died', file: null }, 'unavailable', null, 0],
        [{ status: 'stopped', error: null, file: null }, 'unavailable', null, 0]
    ];
    for (const [outcome, snapshotStatus, snapshotBlocks, writes] of outcomes) {
        test(`GET /runs/:runId reports a run that ended as ${outcome.status} with its snapshot ${snapshotStatus}`, async () => {
            const run = await startRun();

            run.outcome.resolve(outcome);

            const finished = await waitForStatus(run.runId, outcome.status);
            assert.deepInclude(finished, {
                status: outcome.status,
                error: outcome.error,
                snapshotStatus,
                snapshotBlocks
            });
            assert.isString(finished.completedAt);
            verify(runFiles.write(anything(), anything())).times(writes);
            verify(runFiles.updateLatest(anything(), anything(), anything())).never();
        });
    }

    test('GET /runs/:runId reports a run as running until its file is written', async () => {
        const writeStarted = createDeferred<void>();
        const written = createDeferred<boolean>();
        when(runFiles.write(anything(), anything())).thenCall(() => {
            writeStarted.resolve();

            return written.promise;
        });
        const { runId, outcome } = await startRun();
        const [, , onRunning] = capture(runner.run).last();
        onRunning();

        outcome.resolve({ status: 'success', error: null, file: RUN_FILE });
        await writeStarted.promise;

        assert.deepInclude(await getRun(runId), {
            status: 'running',
            snapshotStatus: 'pending',
            snapshotBlocks: null,
            completedAt: null
        });
        written.resolve(true);
        assert.deepInclude(await waitForStatus(runId, 'success'), {
            snapshotStatus: 'available',
            snapshotBlocks: CHART_SNAPSHOT
        });
    });

    test("GET /runs/:runId reports a success as running until its notebook's latest results are updated", async () => {
        const updateStarted = createDeferred<void>();
        const updated = createDeferred<void>();
        when(runFiles.updateLatest(anything(), anything(), anything())).thenCall(() => {
            updateStarted.resolve();

            return updated.promise;
        });
        const { runId, outcome } = await startRun();
        const [, , onRunning] = capture(runner.run).last();
        onRunning();

        outcome.resolve({ status: 'success', error: null, file: RUN_FILE });
        await updateStarted.promise;

        assert.deepInclude(await getRun(runId), { status: 'running', snapshotStatus: 'pending', completedAt: null });
        updated.resolve();
        assert.deepInclude(await waitForStatus(runId, 'success'), { snapshotStatus: 'available' });
    });

    test('GET /runs/:runId reports a success whose file could not be written with its snapshot unavailable', async () => {
        when(runFiles.write(anything(), anything())).thenResolve(false);

        const runId = await finishRun('success');

        assert.deepInclude(await getRun(runId), {
            status: 'success',
            error: null,
            snapshotStatus: 'unavailable',
            snapshotBlocks: null
        });
        verify(runFiles.updateLatest(anything(), anything(), anything())).never();
    });

    test('GET /runs/:runId answers a JSON 500, and logs the error, when the run file cannot be read', async () => {
        const logError = sinon.stub(logger, 'error');
        const runId = await finishRun('success');
        const readFailure = new Error('The run file does not parse');
        when(runFiles.read(anything())).thenReject(readFailure);

        await assertJson(await call('GET', `/runs/${runId}`), 500, { message: INTERNAL_ERROR_MESSAGE });
        assert.deepStrictEqual(
            logError.getCalls().map((logged) => logged.args[1]),
            [readFailure]
        );
    });

    test('GET /runs/:runId reports a runner that rejects as an internal error, and logs it', async () => {
        const logError = sinon.stub(logger, 'error');
        const { runId, outcome } = await startRun();
        const failure = new Error('runner bug');

        outcome.reject(failure);

        assert.deepInclude(await waitForStatus(runId, 'internal_error'), {
            error: 'runner bug',
            snapshotStatus: 'unavailable',
            snapshotBlocks: null
        });
        assert.deepStrictEqual(
            logError.getCalls().map((logged) => logged.args[1]),
            [failure]
        );
    });

    test('GET /runs/:runId answers 404 for a run ID the preview has not started', async () => {
        await assertJson(await call('GET', '/runs/run-1'), 404, { message: RUN_NOT_FOUND_MESSAGE });
    });

    test('dispose() cancels the unfinished runs, and records how the runner ended them', async () => {
        const stopped = await startRun();
        const finished = await startRun();
        finished.outcome.resolve({ status: 'success', error: null, file: RUN_FILE });
        await waitForStatus(finished.runId, 'success');

        api.dispose();

        const [, stoppedToken] = capture(runner.run).first();
        const [, finishedToken] = capture(runner.run).second();
        assert.isTrue(stoppedToken.isCancellationRequested);
        assert.isNotTrue(finishedToken.isCancellationRequested);
        stopped.outcome.resolve({ status: 'stopped', error: null, file: null });
        assert.deepInclude(await waitForStatus(stopped.runId, 'stopped'), { snapshotStatus: 'unavailable' });
    });

    test('dispose() keeps a request that is still looking up its notebook from starting a run', async () => {
        const lookupStarted = createDeferred<void>();
        const lookup = createDeferred<WorkspaceNotebook | undefined>();
        findNotebook.callsFake(() => {
            lookupStarted.resolve();

            return lookup.promise;
        });
        const response = createRun({ notebookId: 'nb-1' });
        await lookupStarted.promise;

        api.dispose();
        lookup.resolve({ file: SALES_FILE, fileUri: SALES_FILE_URI, notebook: SALES_FILE.project.notebooks[1] });

        await assertJson(await response, 503, { message: PREVIEW_STOPPED_MESSAGE });
        verify(runner.run(anything(), anything(), anything())).never();
    });

    const invalidBodies: [string, unknown, string][] = [
        ['without notebookId', { inputs: {} }, 'notebookId is required'],
        [
            'with an empty notebookId',
            { notebookId: '' },
            'notebookId too small: expected string to have >=1 characters'
        ],
        ['with an empty input name', { notebookId: 'nb-1', inputs: { '': 'x' } }, 'inputs. invalid key in record'],
        ['with a number as an input value', { notebookId: 'nb-1', inputs: { a: 1 } }, 'inputs.a invalid input'],
        ['with an unknown key', { notebookId: 'nb-1', x: 1 }, 'Unrecognized key: "x"'],
        ['for an unknown notebook', { notebookId: 'nb-missing' }, NOTEBOOK_NOT_FOUND_MESSAGE],
        [
            'with an input only another notebook of the file defines',
            { notebookId: 'nb-1', inputs: { limit: '5' } },
            'Input "limit" is not defined for this notebook'
        ],
        [
            'with a value the input block cannot hold',
            { notebookId: 'nb-1', inputs: { region: true } },
            'Input "region" must be a string for input-text'
        ]
    ];
    for (const [condition, body, message] of invalidBodies) {
        test(`POST /runs answers 400 to a body ${condition}, without starting a run`, async () => {
            await assertJson(await createRun(body), 400, { message });
            verify(runner.run(anything(), anything(), anything())).never();
        });
    }

    const unreadableBodies: [string, string, number, string][] = [
        ['that is not JSON', '{"notebookId":', 400, 'Unexpected end of JSON input'],
        [
            'over the JSON size limit',
            JSON.stringify({ notebookId: 'nb-1', inputs: { region: 'x'.repeat(200_000) } }),
            413,
            'request entity too large'
        ]
    ];
    for (const [condition, body, status, message] of unreadableBodies) {
        test(`POST /runs answers ${status} to a body ${condition}, without starting a run or logging an error`, async () => {
            const logError = sinon.stub(logger, 'error');

            const response = await fetch(`${baseUrl}/runs`, {
                method: 'POST',
                headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
                body
            });

            await assertJson(response, status, { message });
            verify(runner.run(anything(), anything(), anything())).never();
            sinon.assert.notCalled(logError);
        });
    }

    suite('GET /notebooks/:notebookId/app-data', () => {
        const LATEST_STARTED_AT = '2026-01-01T09:00:00.000Z';

        function latestFile(blocks: DeepnoteBlock[]): DeepnoteFile {
            return createDeepnoteFile({
                execution: { startedAt: LATEST_STARTED_AT, finishedAt: '2026-01-01T09:00:04.000Z' },
                project: createDeepnoteProject({ notebooks: [createDeepnoteNotebook({ id: 'nb-1', blocks })] })
            });
        }

        function jsonBlock(json: Record<string, number>): DeepnoteBlock {
            return codeBlock('chart', [display({ 'application/json': json })]);
        }

        function getAppData(notebookId = 'nb-1'): Promise<Response> {
            return call('GET', `/notebooks/${notebookId}/app-data`);
        }

        test('answers 404 when the notebook has no latest results, though this preview ran it', async () => {
            await finishRun('success');

            await assertJson(await getAppData(), 404, { message: NO_RUN_RESULTS_MESSAGE });
        });

        test("answers the latest results' first JSON object and when that run started, not this preview's own run", async () => {
            await finishRun('success');
            when(runFiles.readLatest('nb-1')).thenResolve(latestFile([jsonBlock({ total: 2 })]));

            await assertJson(await getAppData(), 200, {
                appData: { total: 2 },
                agentBlockSummary: null,
                runCreatedAt: LATEST_STARTED_AT
            });
        });

        test('answers the first JSON object across blocks and their outputs, skipping a JSON array and null', async () => {
            when(runFiles.readLatest('nb-1')).thenResolve(
                latestFile([
                    codeBlock('regions', [
                        stdout('loading'),
                        { output_type: 'display_data', data: { 'application/json': null }, metadata: {} },
                        display({ 'application/json': ['north'] })
                    ]),
                    codeBlock('chart', [
                        display({ 'text/plain': 'chart' }),
                        display({ 'application/json': { total: 3 } }),
                        display({ 'application/json': { total: 4 } })
                    ]),
                    jsonBlock({ total: 5 })
                ])
            );

            await assertJson(await getAppData(), 200, {
                appData: { total: 3 },
                agentBlockSummary: null,
                runCreatedAt: LATEST_STARTED_AT
            });
        });

        test('answers 404 when the latest results have no JSON object, though their text and stream look like one', async () => {
            when(runFiles.readLatest('nb-1')).thenResolve(
                latestFile([
                    codeBlock('chart', [
                        stdout('{"total": 2}'),
                        display({ 'text/plain': '{"total": 2}', 'application/json': ['total'] })
                    ])
                ])
            );

            await assertJson(await getAppData(), 404, { message: NO_JSON_OUTPUT_MESSAGE });
        });

        const agentSummaries: [string, DeepnoteBlock[], string | null][] = [
            [
                'its first markdown output, ahead of its stream text',
                [
                    agentBlock('agent', [
                        stdout('Looking at sales'),
                        display({ 'text/markdown': '**Sales grew.**' }),
                        display({ 'text/markdown': 'More detail' })
                    ])
                ],
                '**Sales grew.**'
            ],
            [
                "its stream text when it has no markdown output, not a later agent block's markdown",
                [
                    agentBlock('agent', [stdout('Sales grew '), stdout('by 5%.')]),
                    agentBlock('second-agent', [display({ 'text/markdown': 'Second answer' })])
                ],
                'Sales grew by 5%.'
            ],
            [
                'null when it has neither a markdown nor a stream output',
                [agentBlock('agent', [display({ 'text/plain': 'Sales grew.' })])],
                null
            ],
            [
                'null when no block is an agent block, though a code block displays markdown',
                [codeBlock('notes', [display({ 'text/markdown': '# Notes' })])],
                null
            ]
        ];
        for (const [condition, blocks, summary] of agentSummaries) {
            test(`summarizes the first agent block as ${condition}`, async () => {
                when(runFiles.readLatest('nb-1')).thenResolve(latestFile([...blocks, jsonBlock({ total: 3 })]));

                await assertJson(await getAppData(), 200, {
                    appData: { total: 3 },
                    agentBlockSummary: summary,
                    runCreatedAt: LATEST_STARTED_AT
                });
            });
        }

        test('answers 404 for an ID no workspace notebook has, without reading any results', async () => {
            await assertJson(await getAppData('nb-deleted'), 404, { message: NOTEBOOK_NOT_FOUND_MESSAGE });
            verify(runFiles.readLatest(anything())).never();
        });

        test('answers a JSON 500, and logs the error, when the latest results cannot be read', async () => {
            const logError = sinon.stub(logger, 'error');
            const readFailure = new Error('The latest results do not parse');
            when(runFiles.readLatest(anything())).thenReject(readFailure);

            await assertJson(await getAppData(), 500, { message: INTERNAL_ERROR_MESSAGE });
            sinon.assert.calledOnceWithExactly(logError, sinon.match.string, readFailure);
        });
    });

    suite('GET /projects/:projectId/dataframes/:name', () => {
        const PROJECT_ID = '5b0d4a8e-2f1c-4e3b-9a6d-7c8e9f0a1b2c';
        const NOT_FOUND = { message: DATAFRAME_NOT_FOUND_MESSAGE };
        // Holds deepnote_dataframes/toolkit_frame, three rows that deepnote-toolkit 2.9.1 stored.
        const FRAMES_PROJECT: AppPreviewProject = {
            id: PROJECT_ID,
            folder: Uri.joinPath(
                Uri.file(EXTENSION_ROOT_DIR_FOR_TESTS),
                'src',
                'test',
                'testFiles',
                'appPreview',
                'frames'
            )
        };
        let emptyFolder: string;

        setup(() => {
            emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-app-preview-api-'));
            getProject.returns(FRAMES_PROJECT);
            // The reader falls back to $HOME/work, which must not hold the developer's own frames here.
            sinon.stub(platformUtils, 'getEnvironmentVariable').callThrough().withArgs('HOME').returns(emptyFolder);
        });

        teardown(() => {
            fs.rmSync(emptyFolder, { recursive: true, force: true });
        });

        function getDataframe(query = '', projectId = PROJECT_ID): Promise<Response> {
            return call('GET', `/projects/${projectId}/dataframes/toolkit_frame${query}`);
        }

        test("answers a page of the frame stored in the project's folder, in Deepnote's shape and key order", async () => {
            const response = await getDataframe('?pageIndex=1&pageSize=2');

            assert.strictEqual(response.status, 200);
            const body = await response.json();
            assert.deepStrictEqual(Object.keys(body), [
                'referenceId',
                'rowCount',
                'columnCount',
                'pageIndex',
                'pageSize',
                'pageCount',
                'columns',
                'rows'
            ]);
            assert.deepStrictEqual(body, {
                referenceId: '937dcee4-b07d-4ee0-9ee9-4793acaaf0a7',
                rowCount: 3,
                columnCount: 4,
                pageIndex: 1,
                pageSize: 2,
                pageCount: 2,
                columns: [
                    { name: 'id', type: 'int64', timezone: null },
                    { name: 'score', type: 'float', timezone: null },
                    { name: 'seen_at', type: 'timestamp', timezone: 'Europe/Prague' },
                    { name: 'label', type: 'string', timezone: null }
                ],
                rows: [['0', -0.25, null, 'žluťoučký']]
            });
        });

        test('answers page 0 of 10 rows without a query', async () => {
            const body = await (await getDataframe()).json();

            assert.deepStrictEqual([body.pageIndex, body.pageSize, body.pageCount, body.rows.length], [0, 10, 1, 3]);
        });

        const invalidRequests: [string, string, string][] = [
            ['a pageSize above 1000', '?pageSize=1001', 'pageSize too big: expected number to be <=1000'],
            [
                'a pageSize that is not a number',
                '?pageSize=ten',
                'pageSize invalid input: expected number, received nan'
            ],
            ['a fractional pageIndex', '?pageIndex=0.5', 'pageIndex invalid input: expected int, received number'],
            ['a fractional pageSize', '?pageSize=2.5', 'pageSize invalid input: expected int, received number'],
            ['a query key Deepnote does not know', '?pageIndex=0&limit=5', 'Unrecognized key: "limit"'],
            [
                'several invalid values',
                '?pageIndex=-1&pageSize=0',
                'pageIndex too small: expected number to be >=0; pageSize too small: expected number to be >=1'
            ],
            [
                'a pageIndex past the last page',
                '?pageIndex=1',
                'pageIndex 1 is out of range: the dataframe has 1 page(s) of 10 rows.'
            ]
        ];
        for (const [condition, query, message] of invalidRequests) {
            test(`answers 400 to ${condition}`, async () => {
                await assertJson(await getDataframe(query), 400, { message });
            });
        }

        test('answers 400 to a name outside [A-Za-z0-9_-]', async () => {
            await assertJson(await call('GET', `/projects/${PROJECT_ID}/dataframes/sales%20by%20month`), 400, {
                message: 'name invalid string: must match pattern /^[a-za-z0-9_-]{1,128}$/'
            });
        });

        test('reads the frames of a project whose ID is not a UUID, as .deepnote files allow', async () => {
            getProject.returns({ ...FRAMES_PROJECT, id: 'e2e-hello-world-project' });

            assert.strictEqual((await getDataframe('', 'e2e-hello-world-project')).status, 200);
        });

        test("answers 404 for a project ID other than the previewed app's project", async () => {
            await assertJson(await getDataframe('', 'a7c3e1f0-9b8d-4c6e-8f2a-1b3c5d7e9f00'), 404, NOT_FOUND);
        });

        test('answers 404 when the previewed app belongs to no project', async () => {
            getProject.returns(undefined);

            await assertJson(await getDataframe(), 404, NOT_FOUND);
        });

        test('asks for the project again on every request', async () => {
            getProject.returns(undefined);
            await assertJson(await getDataframe(), 404, NOT_FOUND);

            getProject.returns(FRAMES_PROJECT);
            assert.strictEqual((await getDataframe()).status, 200);

            getProject.returns({ id: PROJECT_ID, folder: Uri.file(emptyFolder) });
            await assertJson(await getDataframe(), 404, NOT_FOUND);
        });

        test("answers the reader's 422 with its message, without logging an error", async () => {
            const logError = sinon.stub(logger, 'error');
            sinon.stub(zlib, 'zstdDecompressSync').value(undefined);

            await assertJson(await getDataframe(), 422, { message: DeepnoteAppPreview.zstdUnavailable });
            sinon.assert.notCalled(logError);
        });
    });

    const rejectedAuthorizations: [string, string | null][] = [
        ['no authorization header', null],
        ['a wrong token', 'Bearer wrong-token'],
        ['the token with a suffix', `Bearer ${TOKEN}x`],
        ['the token without the Bearer scheme', TOKEN]
    ];
    for (const [condition, authorization] of rejectedAuthorizations) {
        test(`answers 401 to ${condition}, without reaching a handler`, async () => {
            await assertJson(await call('GET', '/notebooks/nb-1', authorization), 401, {
                message: UNAUTHORIZED_MESSAGE
            });
            await assertJson(await call('POST', '/runs', authorization), 401, { message: UNAUTHORIZED_MESSAGE });
            sinon.assert.notCalled(findNotebook);
        });
    }

    test('answers 403 to every other route', async () => {
        const notAvailable = { message: NOT_AVAILABLE_MESSAGE };
        await assertJson(await call('GET', '/projects/p-1'), 403, notAvailable);
        await assertJson(await call('DELETE', '/runs/run-1'), 403, notAvailable);
        await assertJson(await call('POST', '/notebooks/nb-1'), 403, notAvailable);
    });
});
