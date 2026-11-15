import { assert } from 'chai';

import { addDataframe, type DeepnoteConnection, type DeepnoteGlobal } from './deepnoteDataframe';

const NO_PROJECT_MESSAGE =
    "This app folder is not next to or inside the folder of a Deepnote project's .deepnote files, so it has no stored dataframes. After adding one, run Deepnote: Preview App again.";

interface FetchCall {
    url: string;
    method: string | undefined;
    authorization: string | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

suite('addDataframe', () => {
    let calls: FetchCall[];
    let replies: Response[];

    const fakeFetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
            url: String(input),
            method: init?.method,
            authorization: headers.get('authorization') ?? undefined
        });
        const reply = replies.shift();
        if (!reply) {
            throw new Error(`Unexpected request to ${String(input)}`);
        }

        return reply;
    };

    function tokenReply(projectId: string | null = 'project 1'): Response {
        return jsonResponse(200, {
            token: 'token-1',
            apiOrigin: 'http://127.0.0.1:5000',
            expiresAtSeconds: 2_000_000_000,
            ...(projectId === null ? {} : { projectId })
        });
    }

    function connectWith(connection: DeepnoteConnection = {}): DeepnoteConnection {
        const deepnote: DeepnoteGlobal = { connect: () => connection };
        addDataframe(deepnote, fakeFetch);

        return deepnote.connect();
    }

    setup(() => {
        calls = [];
        replies = [];
    });

    test("pages through the frame with the token, API origin and project of the preview's token endpoint", async () => {
        const page = { rows: [{ id: 1 }], pageIndex: 2, pageSize: 50 };
        replies = [tokenReply(), jsonResponse(200, page)];

        const result = await connectWith().dataframe!('sales frame', { pageIndex: 2, pageSize: 50 });

        assert.deepStrictEqual(result, page);
        assert.deepStrictEqual(calls, [
            { url: '/__deepnote/api-token', method: 'POST', authorization: undefined },
            {
                url: 'http://127.0.0.1:5000/v2/projects/project%201/dataframes/sales%20frame?pageIndex=2&pageSize=50',
                method: undefined,
                authorization: 'Bearer token-1'
            }
        ]);
    });

    test('leaves the page to the API when no page is given', async () => {
        replies = [tokenReply(), jsonResponse(200, { rows: [] })];

        await connectWith().dataframe!('sales');

        assert.strictEqual(calls[1].url, 'http://127.0.0.1:5000/v2/projects/project%201/dataframes/sales');
    });

    test("passes connect()'s options to the client and keeps the connection's own methods", () => {
        const notebook = () => undefined;
        const seen: unknown[][] = [];
        const deepnote: DeepnoteGlobal = {
            connect: (...args) => {
                seen.push(args);

                return { notebook } as DeepnoteConnection;
            }
        };
        addDataframe(deepnote, fakeFetch);
        const options = { onAuthExpired: () => undefined };

        const connection = deepnote.connect(options) as DeepnoteConnection & { notebook: unknown };

        assert.deepStrictEqual(seen, [[options]]);
        assert.strictEqual(connection.notebook, notebook);
        assert.isFunction(connection.dataframe);
    });

    test("leaves a dataframe() that the client's connection has in place", () => {
        const own = async () => 'own page';

        const connection = connectWith({ dataframe: own });

        assert.strictEqual(connection.dataframe, own);
    });

    test("rejects with the API's message", async () => {
        replies = [tokenReply(), jsonResponse(404, { message: 'Dataframe not found' })];

        await assert.isRejected(connectWith().dataframe!('sales'), /^Dataframe not found$/);
    });

    test('rejects with the status when the answer has no message', async () => {
        replies = [tokenReply(), new Response('Internal error', { status: 500 })];

        await assert.isRejected(connectWith().dataframe!('sales'), /^Request failed with status 500$/);
    });

    test('rejects with the status when the token endpoint refuses', async () => {
        replies = [new Response('Forbidden', { status: 403 })];

        await assert.isRejected(connectWith().dataframe!('sales'), /^Request failed with status 403$/);
    });

    test('rejects without asking the API when the app has no project', async () => {
        replies = [tokenReply(null)];

        await assert.isRejected(connectWith().dataframe!('sales'), NO_PROJECT_MESSAGE);
        assert.lengthOf(calls, 1);
    });
});
