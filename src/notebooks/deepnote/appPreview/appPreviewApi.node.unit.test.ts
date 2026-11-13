import { assert } from 'chai';
import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { Uri } from 'vscode';

import {
    createDeepnoteBlock,
    createDeepnoteFile,
    createDeepnoteNotebook,
    createDeepnoteProject
} from '../deepnoteTestHelpers';
import { createAppPreviewApi, type AppPreviewOperation } from './appPreviewApi.node';
import type { WorkspaceNotebook } from './appPreviewWorkspace.node';

const TOKEN = 'preview-token';

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
            })
        ]
    })
});

suite('createAppPreviewApi', () => {
    let server: http.Server;
    let baseUrl: string;
    let unsupported: AppPreviewOperation[];
    let lookups: string[];

    setup(async () => {
        unsupported = [];
        lookups = [];
        const notebooks = new Map<string, WorkspaceNotebook>(
            SALES_FILE.project.notebooks.map((notebook) => [
                notebook.id,
                { file: SALES_FILE, fileUri: Uri.file('/workspace/sales.deepnote'), notebook }
            ])
        );
        const app = express();
        app.use(
            '/__deepnote/v2',
            createAppPreviewApi({
                token: TOKEN,
                findNotebook: async (notebookId) => {
                    lookups.push(notebookId);

                    return notebooks.get(notebookId);
                },
                onUnsupported: (operation) => unsupported.push(operation)
            })
        );
        server = http.createServer(app);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__deepnote/v2`;
    });

    teardown(() => {
        server.closeAllConnections();
        server.close();
    });

    function call(method: string, path: string, authorization: string | null = `Bearer ${TOKEN}`): Promise<Response> {
        return fetch(`${baseUrl}${path}`, { method, headers: authorization === null ? {} : { authorization } });
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

    const stubs: [string, string, AppPreviewOperation][] = [
        ['GET', '/notebooks/nb-1/app-data', 'appData()'],
        ['POST', '/runs', 'run()'],
        ['GET', '/runs/run-1', 'run()'],
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
