import { assert } from 'chai';
import express, { type Request, type Response } from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { createDeepnoteClient, type DeepnoteRun, type RunPhase } from './deepnoteClient';

const TOKEN = 'page-token';

interface RecordedRequest {
    method: string;
    url: string;
    authorization: string | undefined;
    contentType: string | undefined;
    body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

suite('createDeepnoteClient', () => {
    let server: http.Server;
    let apiBaseUrl: string;
    let requests: RecordedRequest[];
    let runPolls: Partial<DeepnoteRun>[];
    let dataframeReplies: Reply[];
    let notebookReply: Reply;
    let clock: number;
    let sleeps: number[];

    function client(config: { token?: string; projectId?: string } = { token: TOKEN, projectId: 'p-1' }) {
        return createDeepnoteClient(
            { token: config.token, projectId: config.projectId, apiBaseUrl },
            {
                fetch,
                now: () => clock,
                sleep: async (ms) => {
                    sleeps.push(ms);
                    clock += ms;
                }
            }
        ).connect();
    }

    function send(res: Response, reply: Reply): void {
        res.status(reply.status).set(reply.headers ?? {});
        if (typeof reply.body === 'string') {
            res.send(reply.body);
        } else {
            res.json(reply.body ?? {});
        }
    }

    setup(async () => {
        requests = [];
        runPolls = [];
        dataframeReplies = [];
        notebookReply = { status: 200, body: { notebook: { id: 'nb-1', inputs: [{ name: 'region' }] } } };
        clock = 0;
        sleeps = [];

        const app = express();
        app.use(express.json());
        app.use((req: Request, res: Response, next) => {
            requests.push({
                method: req.method,
                url: req.originalUrl,
                authorization: req.headers.authorization,
                contentType: req.headers['content-type'],
                body: req.body
            });
            if (req.headers.authorization !== `Bearer ${TOKEN}`) {
                res.status(401).json({ message: 'Unauthorized' });

                return;
            }
            next();
        });
        app.get('/api/notebooks/:id', (_req, res) => send(res, notebookReply));
        app.get('/api/notebooks/:id/app-data', (_req, res) => res.json({ tables: ['sales'] }));
        app.post('/api/runs', (_req, res) => res.status(202).json({ runId: 'run-1', status: 'pending' }));
        app.get('/api/runs/:runId', (_req, res) => {
            const run = runPolls.length > 1 ? runPolls.shift()! : runPolls[0];
            res.json({ run: { runId: 'run-1', ...run } });
        });
        app.get('/api/projects/:projectId/dataframes/:name', (_req, res) =>
            send(res, dataframeReplies.shift() ?? { status: 200, body: { rows: [] } })
        );

        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    });

    teardown(() => {
        server.closeAllConnections();
        server.close();
    });

    async function rejection(promise: Promise<unknown>): Promise<string> {
        try {
            await promise;
        } catch (error) {
            return (error as Error).message;
        }
        assert.fail('the call resolved');
    }

    test('inputs() and appData() send the bearer token and the JSON content type', async () => {
        const notebook = client().notebook('nb-1');

        assert.deepStrictEqual(await notebook.inputs(), [{ name: 'region' }]);
        assert.deepStrictEqual(await notebook.appData(), { tables: ['sales'] });
        assert.deepStrictEqual(
            requests.map(({ method, url, authorization, contentType }) => [method, url, authorization, contentType]),
            [
                ['GET', '/api/notebooks/nb-1', `Bearer ${TOKEN}`, 'application/json'],
                ['GET', '/api/notebooks/nb-1/app-data', `Bearer ${TOKEN}`, 'application/json']
            ]
        );
    });

    test('inputs() returns [] for a notebook without inputs', async () => {
        notebookReply = { status: 200, body: { notebook: { id: 'nb-1' } } };

        assert.deepStrictEqual(await client().notebook('nb-1').inputs(), []);
    });

    test('run() posts the run, then polls every 2 s through pending and running to success', async () => {
        runPolls = [
            { status: 'pending' },
            { status: 'running' },
            { status: 'success', snapshotStatus: 'available', snapshotBlocks: [] }
        ];
        const progress: [string, RunPhase][] = [];

        const { run } = await client()
            .notebook('nb-1')
            .run({ region: 'EU' }, { onProgress: (polled, phase) => progress.push([polled.status, phase]) });

        assert.strictEqual(run.status, 'success');
        assert.deepStrictEqual(requests[0].body, {
            notebookId: 'nb-1',
            inputs: { region: 'EU' },
            detachedRunStorageMode: 'readonly'
        });
        assert.deepStrictEqual(
            requests.map(({ method, url }) => `${method} ${url}`),
            ['POST /api/runs', 'GET /api/runs/run-1', 'GET /api/runs/run-1', 'GET /api/runs/run-1']
        );
        assert.deepStrictEqual(progress, [
            ['pending', 'executing'],
            ['running', 'executing']
        ]);
        assert.deepStrictEqual(sleeps, [2_000, 2_000]);
    });

    test('run() resolves on an error status', async () => {
        runPolls = [{ status: 'error', snapshotStatus: 'available', snapshotBlocks: [] }];

        const { run } = await client().notebook('nb-1').run({});

        assert.strictEqual(run.status, 'error');
    });

    test('run() waits up to 15 polls for a successful run to store its result', async () => {
        runPolls = [{ status: 'success', snapshotStatus: 'pending', snapshotBlocks: null }];
        const phases: RunPhase[] = [];

        const { run, result } = await client()
            .notebook('nb-1')
            .run({}, { onProgress: (_polled, phase) => phases.push(phase) });

        assert.strictEqual(run.status, 'success');
        assert.isNull(result());
        assert.deepStrictEqual(phases, Array(15).fill('storing-result'));
        assert.strictEqual(requests.filter(({ url }) => url === '/api/runs/run-1').length, 16);
    });

    test('run() returns once the stored result arrives', async () => {
        runPolls = [
            { status: 'success', snapshotStatus: 'pending', snapshotBlocks: null },
            {
                status: 'success',
                snapshotStatus: 'available',
                snapshotBlocks: [{ outputs: [{ data: { 'application/json': { total: 3 } } }] }]
            }
        ];

        const { result } = await client().notebook('nb-1').run({});

        assert.deepStrictEqual(result(), { total: 3 });
        assert.deepStrictEqual(sleeps, [2_000]);
    });

    test('run() rejects when a successful run could not save its results', async () => {
        runPolls = [{ status: 'success', snapshotStatus: 'unavailable', snapshotBlocks: null }];

        assert.strictEqual(
            await rejection(client().notebook('nb-1').run({})),
            'The notebook finished, but Deepnote could not save its results. Check run history and try again.'
        );
    });

    test('run() rejects once the timeout passes', async () => {
        runPolls = [{ status: 'running' }];

        assert.strictEqual(
            await rejection(client().notebook('nb-1').run({}, { timeoutMs: 5_000 })),
            'Run run-1 did not finish in time.'
        );
        assert.deepStrictEqual(sleeps, [2_000, 2_000, 2_000]);
    });

    test('result() skips falsy payloads and filters by schema, except for an empty schema', async () => {
        const first = { schema: 'a', value: 1 };
        const second = { schema: 'b', value: 2 };
        runPolls = [
            {
                status: 'success',
                snapshotStatus: 'available',
                snapshotBlocks: [
                    {
                        outputs: [
                            { data: { 'application/json': 0 } },
                            { data: { 'application/json': false } },
                            { data: { 'text/plain': 'printed' } }
                        ]
                    },
                    {
                        outputs: [
                            { data: { 'application/json': '' } },
                            { data: { 'application/json': null } },
                            { data: { 'application/json': first } },
                            { data: { 'application/json': second } }
                        ]
                    }
                ]
            }
        ];

        const { result } = await client().notebook('nb-1').run({});

        assert.deepStrictEqual(result(), first);
        assert.deepStrictEqual(result(''), first);
        assert.deepStrictEqual(result('b'), second);
        assert.isNull(result('c'));
    });

    test('a non-2xx response rejects with its message, or with its status without one', async () => {
        notebookReply = { status: 404, body: { message: 'Notebook not found' } };
        assert.strictEqual(await rejection(client().notebook('nb-1').inputs()), 'Notebook not found');

        notebookReply = { status: 502, body: '<html>Bad gateway</html>' };
        assert.strictEqual(await rejection(client().notebook('nb-1').inputs()), 'Request failed with status 502');

        assert.strictEqual(
            await rejection(client({ token: 'expired', projectId: 'p-1' }).notebook('nb-1').inputs()),
            'Unauthorized'
        );
    });

    test('dataframe() encodes the name and sends only the given paging options', async () => {
        const connection = client();

        assert.deepStrictEqual(await connection.dataframe('sales / q1', { pageIndex: 0, pageSize: 50 }), {
            rows: []
        });
        await connection.dataframe('orders');
        await connection.dataframe('orders', { pageSize: 10 });

        assert.deepStrictEqual(
            requests.map(({ url }) => url),
            [
                '/api/projects/p-1/dataframes/sales%20%2F%20q1?pageIndex=0&pageSize=50',
                '/api/projects/p-1/dataframes/orders',
                '/api/projects/p-1/dataframes/orders?pageSize=10'
            ]
        );
    });

    test('dataframe() retries a 429 up to 3 times after Retry-After, 1 s when it is missing', async () => {
        const tooMany = (retryAfter?: string): Reply => ({
            status: 429,
            body: { message: 'Too many requests' },
            headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter }
        });
        dataframeReplies = [tooMany('2'), tooMany(), tooMany('5')];

        assert.deepStrictEqual(await client().dataframe('orders'), { rows: [] });
        assert.deepStrictEqual(sleeps, [2_000, 1_000, 5_000]);
        assert.strictEqual(requests.length, 4);
    });

    test('dataframe() gives up after 3 retries, or at once when Retry-After is over 5 s', async () => {
        const tooMany = (retryAfter: string): Reply => ({
            status: 429,
            body: { message: 'Too many requests' },
            headers: { 'Retry-After': retryAfter }
        });

        dataframeReplies = [tooMany('1'), tooMany('1'), tooMany('1'), tooMany('1')];
        assert.strictEqual(await rejection(client().dataframe('orders')), 'Too many requests');
        assert.deepStrictEqual(sleeps, [1_000, 1_000, 1_000]);
        assert.strictEqual(requests.length, 4);

        sleeps = [];
        requests = [];
        dataframeReplies = [tooMany('6')];
        assert.strictEqual(await rejection(client().dataframe('orders')), 'Too many requests');
        assert.deepStrictEqual(sleeps, []);
        assert.strictEqual(requests.length, 1);
    });

    test('other calls do not retry a 429', async () => {
        notebookReply = { status: 429, body: { message: 'Too many requests' }, headers: { 'Retry-After': '1' } };

        assert.strictEqual(await rejection(client().notebook('nb-1').inputs()), 'Too many requests');
        assert.strictEqual(requests.length, 1);
    });

    test('rejects every call without a token, and dataframe() without a project, before any request', async () => {
        const noTokenMessage = 'Could not reach the app preview. Open the app with the Deepnote: Preview App command.';
        const noToken = client({ projectId: 'p-1' });
        const notebook = noToken.notebook('nb-1');

        assert.strictEqual(await rejection(notebook.inputs()), noTokenMessage);
        assert.strictEqual(await rejection(notebook.appData()), noTokenMessage);
        assert.strictEqual(await rejection(notebook.run({})), noTokenMessage);
        assert.strictEqual(await rejection(noToken.dataframe('orders')), noTokenMessage);
        assert.strictEqual(
            await rejection(client({ token: TOKEN }).dataframe('orders')),
            "This app folder is not next to or inside the folder of a Deepnote project's .deepnote files, so it has no stored dataframes. After adding one, run Deepnote: Preview App again."
        );
        assert.deepStrictEqual(requests, []);
    });
});
