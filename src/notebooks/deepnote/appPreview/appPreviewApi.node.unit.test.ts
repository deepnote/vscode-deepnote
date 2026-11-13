import { assert } from 'chai';
import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as sinon from 'sinon';
import { Uri, type CancellationToken } from 'vscode';

import { isUUID } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject
} from '../deepnoteTestHelpers';
import { createAppPreviewApi, type AppPreviewApi, type AppPreviewOperation } from './appPreviewApi.node';
import type { WorkspaceNotebook } from './appPreviewWorkspace.node';
import type { AppPreviewRunOutcome, AppPreviewRunRequest, IAppPreviewRunner, SnapshotBlock } from './types';

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

interface RunnerCall {
    request: AppPreviewRunRequest;
    token: CancellationToken;
    onRunning(): void;
    finish(outcome: AppPreviewRunOutcome): void;
    fail(error: Error): void;
}

class FakeRunner implements IAppPreviewRunner {
    public readonly calls: RunnerCall[] = [];

    public run(request: AppPreviewRunRequest, token: CancellationToken, onRunning: () => void) {
        return new Promise<AppPreviewRunOutcome>((finish, fail) =>
            this.calls.push({ request, token, onRunning, finish, fail })
        );
    }
}

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

suite('createAppPreviewApi', () => {
    let server: http.Server;
    let baseUrl: string;
    let api: AppPreviewApi;
    let runner: FakeRunner;
    let unsupported: AppPreviewOperation[];
    let lookups: string[];
    let lookupFailure: Error | undefined;

    setup(async () => {
        unsupported = [];
        lookups = [];
        lookupFailure = undefined;
        runner = new FakeRunner();
        const notebooks = new Map<string, WorkspaceNotebook>(
            SALES_FILE.project.notebooks.map((notebook) => [
                notebook.id,
                { file: SALES_FILE, fileUri: SALES_FILE_URI, notebook }
            ])
        );
        api = createAppPreviewApi({
            token: TOKEN,
            findNotebook: async (notebookId) => {
                lookups.push(notebookId);
                if (lookupFailure) {
                    throw lookupFailure;
                }

                return notebooks.get(notebookId);
            },
            onUnsupported: (operation) => unsupported.push(operation),
            runner
        });
        const app = express();
        app.use('/__deepnote/v2', api.router);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__deepnote/v2`;
    });

    teardown(() => {
        sinon.restore();
        api.dispose();
        server.closeAllConnections();
        server.close();
    });

    function call(method: string, path: string, authorization: string | null = `Bearer ${TOKEN}`): Promise<Response> {
        return fetch(`${baseUrl}${path}`, { method, headers: authorization === null ? {} : { authorization } });
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

    async function startRun(): Promise<string> {
        const response = await createRun({ notebookId: 'nb-1', inputs: { region: 'Asia' } });
        assert.strictEqual(response.status, 202);

        return (await response.json()).runId;
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
        assert.deepStrictEqual(unsupported, []);
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
        await assertJson(await call('GET', '/notebooks/nb-missing'), 404, { message: 'Notebook not found' });
        assert.deepStrictEqual(unsupported, []);
    });

    test('answers a JSON 500 without the stack, and logs the error, when the notebook lookup fails', async () => {
        const logError = sinon.stub(logger, 'error');
        lookupFailure = new Error('findFiles failed in /home/user/project');

        await assertJson(await call('GET', '/notebooks/nb-1'), 500, { message: 'Internal server error' });
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
        assert.deepStrictEqual(
            runner.calls.map((runCall) => runCall.request),
            [{ fileUri: SALES_FILE_URI, notebookId: 'nb-1', inputs: { region: 'Asia' } }]
        );
        assert.deepStrictEqual(unsupported, []);
    });

    test('POST /runs runs the notebook without inputs when the body has none', async () => {
        assert.strictEqual((await createRun({ notebookId: 'nb-init' })).status, 202);

        assert.deepStrictEqual(
            runner.calls.map((runCall) => runCall.request),
            [{ fileUri: SALES_FILE_URI, notebookId: 'nb-init', inputs: {} }]
        );
    });

    test("GET /runs/:runId reports the run as pending, running, and then finished, in Deepnote's shape", async () => {
        const clock = sinon.useFakeTimers({ now: Date.parse(NOW), toFake: ['Date'] });
        const runId = await startRun();
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

        runner.calls[0].onRunning();
        assert.deepStrictEqual(await getRun(runId), { ...pending, status: 'running' });

        clock.tick(65_000);
        runner.calls[0].finish({ status: 'success', error: null, snapshotBlocks: CHART_SNAPSHOT });
        assert.deepStrictEqual(await waitForStatus(runId, 'success'), {
            ...pending,
            status: 'success',
            snapshotStatus: 'available',
            snapshotBlocks: CHART_SNAPSHOT,
            completedAt: '2026-01-02T03:05:10.000Z'
        });
        assert.deepStrictEqual(unsupported, []);
    });

    const outcomes: [AppPreviewRunOutcome, string][] = [
        [{ status: 'error', error: 'ValueError: no data', snapshotBlocks: CHART_SNAPSHOT }, 'available'],
        [{ status: 'internal_error', error: 'The kernel died', snapshotBlocks: null }, 'unavailable'],
        [{ status: 'stopped', error: null, snapshotBlocks: null }, 'unavailable']
    ];
    for (const [outcome, snapshotStatus] of outcomes) {
        test(`GET /runs/:runId reports a run that ended as ${outcome.status} with its snapshot ${snapshotStatus}`, async () => {
            const runId = await startRun();

            runner.calls[0].finish(outcome);

            const run = await waitForStatus(runId, outcome.status);
            assert.deepInclude(run, { ...outcome, snapshotStatus });
            assert.isString(run.completedAt);
        });
    }

    test('GET /runs/:runId reports a runner that rejects as an internal error, and logs it', async () => {
        const logError = sinon.stub(logger, 'error');
        const runId = await startRun();
        const failure = new Error('runner bug');

        runner.calls[0].fail(failure);

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
        await assertJson(await call('GET', '/runs/run-1'), 404, { message: 'Run not found' });
    });

    test('dispose() cancels the unfinished runs, and records how the runner ended them', async () => {
        const stoppedRunId = await startRun();
        const finishedRunId = await startRun();
        runner.calls[1].finish({ status: 'success', error: null, snapshotBlocks: [] });
        await waitForStatus(finishedRunId, 'success');

        api.dispose();

        assert.deepStrictEqual(
            runner.calls.map((runCall) => runCall.token.isCancellationRequested === true),
            [true, false]
        );
        runner.calls[0].finish({ status: 'stopped', error: null, snapshotBlocks: null });
        assert.deepInclude(await waitForStatus(stoppedRunId, 'stopped'), { snapshotStatus: 'unavailable' });
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
        ['for an unknown notebook', { notebookId: 'nb-missing' }, 'Notebook not found'],
        [
            'with an input the notebook does not define',
            { notebookId: 'nb-1', inputs: { unknown: 'x' } },
            'Input "unknown" is not defined for this notebook'
        ],
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
            assert.deepStrictEqual(runner.calls, []);
        });
    }

    const stubs: [string, string, AppPreviewOperation][] = [
        ['GET', '/notebooks/nb-1/app-data', 'appData()'],
        ['GET', '/projects/p-1/dataframes/sales%20by%20month', 'dataframe()']
    ];
    for (const [method, path, operation] of stubs) {
        test(`${method} ${path} answers 501 for ${operation}`, async () => {
            await assertJson(await call(method, path), 501, {
                message: `${operation} is not supported in the local preview yet.`
            });
            assert.deepStrictEqual(unsupported, [operation]);
        });
    }

    const rejectedAuthorizations: [string, string | null][] = [
        ['no authorization header', null],
        ['a wrong token', 'Bearer wrong-token'],
        ['the token with a suffix', `Bearer ${TOKEN}x`],
        ['the token without the Bearer scheme', TOKEN]
    ];
    for (const [condition, authorization] of rejectedAuthorizations) {
        test(`answers 401 to ${condition}, without reaching a handler`, async () => {
            await assertJson(await call('GET', '/notebooks/nb-1', authorization), 401, { message: 'Unauthorized' });
            await assertJson(await call('POST', '/runs', authorization), 401, { message: 'Unauthorized' });
            assert.deepStrictEqual(lookups, []);
            assert.deepStrictEqual(unsupported, []);
        });
    }

    test('answers 403 to every other route', async () => {
        const notAvailable = { message: 'This endpoint is not available to app viewer tokens' };
        await assertJson(await call('GET', '/projects/p-1'), 403, notAvailable);
        await assertJson(await call('DELETE', '/runs/run-1'), 403, notAvailable);
        await assertJson(await call('POST', '/notebooks/nb-1'), 403, notAvailable);
        assert.deepStrictEqual(unsupported, []);
    });
});
