import { assert } from 'chai';
import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { createAppPreviewApi, type AppPreviewOperation } from './appPreviewApi.node';

const TOKEN = 'preview-token';

suite('createAppPreviewApi', () => {
    let server: http.Server;
    let baseUrl: string;
    let unsupported: AppPreviewOperation[];

    setup(async () => {
        unsupported = [];
        const app = express();
        app.use(
            '/__deepnote/v2',
            createAppPreviewApi({ token: TOKEN, onUnsupported: (operation) => unsupported.push(operation) })
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

    const stubs: [string, string, AppPreviewOperation][] = [
        ['GET', '/notebooks/nb-1', 'inputs()'],
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
        test(`answers 401 to ${condition}, without reaching a stub`, async () => {
            await assertJson(await call('GET', '/notebooks/nb-1', authorization), 401, { message: 'Unauthorized' });
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
