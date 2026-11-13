import { assert } from 'chai';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { anything, when } from 'ts-mockito';
import { Uri } from 'vscode';

import * as path from '../../../platform/vscode-path/path';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import type { AppPreviewOperation } from './appPreviewApi.node';
import { AppPreviewSession, type AppPreviewProject } from './appPreviewSession.node';

const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:";
const CLIENT_SCRIPT = '/* the bundled client */\n';
const HOSTED = 'https://deepnote.com/static/app-client/v1.js';
const SWAPPED = '<script src="/__deepnote/client.js">';

interface TokenReply {
    token: string;
    apiOrigin: string;
    expiresAtSeconds: number;
    projectId?: string;
}

interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

/** A raw request, so paths keep their `..` segments and the Host header can be set. */
function request(
    session: AppPreviewSession,
    urlPath: string,
    options: { method?: string; host?: string; headers?: http.OutgoingHttpHeaders } = {}
): Promise<RawResponse> {
    const port = Number(new URL(session.serverUrl.toString(true)).port);

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                // A fresh connection, so a request after dispose() cannot reuse a pooled socket.
                agent: false,
                path: urlPath,
                method: options.method ?? 'GET',
                headers: { ...options.headers, ...(options.host ? { host: options.host } : {}) }
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) })
                );
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end();
    });
}

async function getText(session: AppPreviewSession, urlPath: string): Promise<string> {
    const response = await request(session, urlPath);
    assert.strictEqual(response.status, 200, `GET ${urlPath}`);

    return response.body.toString('utf8');
}

function forwardTo(url: string): void {
    when(mockedVSCodeNamespaces.env.asExternalUri(anything())).thenCall(() => Promise.resolve(Uri.parse(url)));
}

async function requestToken(session: AppPreviewSession): Promise<TokenReply> {
    const response = await request(session, '/__deepnote/api-token', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:1234' }
    });
    assert.strictEqual(response.status, 200);

    return JSON.parse(response.body.toString()) as TokenReply;
}

suite('AppPreviewSession', () => {
    let tmp: string;
    let appFolder: string;
    let clientScript: string;
    let sessions: AppPreviewSession[];
    let unsupported: AppPreviewOperation[];

    async function startSession(
        options: { folder?: string; project?: AppPreviewProject | null } = {}
    ): Promise<AppPreviewSession> {
        const project = options.project === undefined ? { id: 'project-1', folder: Uri.file(tmp) } : options.project;
        const session = new AppPreviewSession({
            folder: Uri.file(options.folder ?? appFolder),
            project: project ?? undefined,
            scripts: { appClient: Uri.file(clientScript) },
            onUnsupported: (operation) => unsupported.push(operation)
        });
        sessions.push(session);
        await session.start();

        return session;
    }

    function write(relativePath: string, contents: string | Buffer, root = appFolder): void {
        const file = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }

    setup(() => {
        resetVSCodeMocks();
        unsupported = [];
        sessions = [];
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-app-preview-'));
        appFolder = path.join(tmp, 'app');
        clientScript = path.join(tmp, '.ext', 'v1.js');
        write('.ext/v1.js', CLIENT_SCRIPT, tmp);
        write('index.html', '<h1>home</h1>');
        write('sub/index.html', '<h1>sub</h1>');
        write('my file #1.txt', 'spaced');
        write('assets/app.css', 'body { color: red; }');
        write('__deepnote/x.js', 'shadowed');
    });

    teardown(() => {
        sessions.forEach((session) => session.dispose());
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    suite('files', () => {
        test('serves index.html for / and /sub/, ignoring the query', async () => {
            const session = await startSession();

            assert.strictEqual(await getText(session, '/'), '<h1>home</h1>');
            assert.strictEqual(await getText(session, '/sub/'), '<h1>sub</h1>');
            assert.strictEqual(await getText(session, '/sub/?v=2'), '<h1>sub</h1>');
        });

        const directoryRedirects: [string, string, string][] = [
            ['adding no query when it has none', '/sub', '/sub/'],
            // Re-serializing the parsed query writes `a+b` (URLSearchParams) or a bare `~` (querystring).
            ['keeping the query as sent', '/sub?region=EU&q=a%20b%7E', '/sub/?region=EU&q=a%20b%7E']
        ];
        for (const [condition, urlPath, location] of directoryRedirects) {
            test(`redirects a directory requested without a trailing slash to its path with one, ${condition}`, async () => {
                const session = await startSession();

                const redirect = await request(session, urlPath);

                assert.strictEqual(redirect.status, 302);
                assert.strictEqual(redirect.headers.location, location);
            });
        }

        test('serves files by their exact decoded names', async () => {
            const session = await startSession();

            assert.strictEqual(await getText(session, '/my%20file%20%231.txt'), 'spaced');
            assert.strictEqual(await getText(session, '/assets/app.css?cache=1'), 'body { color: red; }');
        });

        test('serves a synced app folder under a dot-named .files folder, dot-named entries included', async () => {
            const synced = path.join(tmp, 'proj', '.files', '_deepnote_static');
            write('index.html', '<h1>synced</h1>', synced);
            write('assets/app.css', 'p {}', synced);
            write('.well-known/info.txt', 'info', synced);
            const session = await startSession({ folder: synced });

            assert.strictEqual(await getText(session, '/'), '<h1>synced</h1>');
            assert.strictEqual(await getText(session, '/assets/app.css'), 'p {}');
            assert.strictEqual(await getText(session, '/.well-known/info.txt'), 'info');
        });

        const notFoundPaths: [string, string][] = [
            ['a .. segment, even percent-encoded and inside the folder', '/sub/%2e%2e/index.html'],
            ['a NUL character', '/index.html%00.css'],
            ['a missing file', '/missing.txt'],
            ['a file under /__deepnote/', '/__deepnote/x.js'],
            ['a file under a percent-encoded /__deepnote/', '/%5F_deepnote/x.js'],
            ['/__deepnote itself', '/__deepnote']
        ];
        for (const [condition, urlPath] of notFoundPaths) {
            test(`answers 404 to ${condition}`, async () => {
                const session = await startSession();

                const response = await request(session, urlPath);

                assert.strictEqual(response.status, 404);
                assert.strictEqual(response.body.toString(), 'Not found');
            });
        }

        test('answers 404 to a symlink to a file outside the folder', async () => {
            write('secret.txt', 'outside', `${appFolder}-other`);
            fs.symlinkSync(path.join(`${appFolder}-other`, 'secret.txt'), path.join(appFolder, 'escape.txt'));
            const session = await startSession();

            const response = await request(session, '/escape.txt');

            assert.strictEqual(response.status, 404);
            assert.strictEqual(response.body.toString(), 'Not found');
        });

        test('answers 405 to methods other than GET and HEAD', async () => {
            const session = await startSession();

            assert.strictEqual((await request(session, '/index.html', { method: 'POST' })).status, 405);
            assert.strictEqual((await request(session, '/', { method: 'PUT' })).status, 405);
            assert.strictEqual((await request(session, '/assets/app.css', { method: 'HEAD' })).status, 200);
        });

        test("sends Deepnote's file headers without frame-ancestors, and no-store on HTML", async () => {
            const session = await startSession();

            const css = await request(session, '/assets/app.css');
            assert.strictEqual(css.headers['cache-control'], 'private, no-cache');
            assert.strictEqual(css.headers['referrer-policy'], 'no-referrer');
            assert.strictEqual(css.headers['content-type'], 'text/css; charset=utf-8');
            assert.strictEqual(css.headers['content-security-policy'], CSP);

            const html = await request(session, '/');
            assert.strictEqual(html.headers['cache-control'], 'no-store');
            assert.strictEqual(html.headers['referrer-policy'], 'no-referrer');
            assert.strictEqual(html.headers['content-type'], 'text/html; charset=utf-8');
            assert.strictEqual(html.headers['content-security-policy'], CSP);
        });
    });

    suite('network', () => {
        test('listens on 127.0.0.1 only', async function () {
            const external = Object.values(os.networkInterfaces())
                .flat()
                .find((address) => address?.family === 'IPv4' && !address.internal);
            if (!external) {
                this.skip();
            }
            const session = await startSession();
            const port = Number(new URL(session.serverUrl.toString(true)).port);

            assert.match(session.serverUrl.toString(true), /^http:\/\/127\.0\.0\.1:\d+\/$/);
            const error = await fetch(`http://${external!.address}:${port}/`).then(
                () => undefined,
                (reason: Error) => reason
            );
            assert.strictEqual((error?.cause as NodeJS.ErrnoException | undefined)?.code, 'ECONNREFUSED');
        });

        test('answers 403 to a Host that is neither loopback nor the current forwarded URL', async () => {
            const session = await startSession();
            const status = async (host: string) => (await request(session, '/', { host })).status;

            assert.strictEqual(await status('127.0.0.1:1234'), 200);
            assert.strictEqual(await status('localhost'), 200);
            assert.strictEqual(await status('[::1]:1234'), 200);
            assert.strictEqual(await status('evil.example'), 403);

            forwardTo('https://first.example/');
            await session.resolveUrls();
            assert.strictEqual(await status('first.example'), 200);

            forwardTo('https://second.example/');
            await session.resolveUrls();
            assert.strictEqual(await status('second.example'), 200);
            assert.strictEqual(await status('first.example'), 403);
            assert.strictEqual((await request(session, '/__deepnote/client.js', { host: 'evil.example' })).status, 403);
        });

        test('dispose() closes the port', async () => {
            const session = await startSession();
            await getText(session, '/');

            session.dispose();

            const error = await request(session, '/').then(
                () => undefined,
                (reason: NodeJS.ErrnoException) => reason
            );
            assert.strictEqual(error?.code, 'ECONNREFUSED');
        });
    });

    suite('client and API', () => {
        test('serves the client script from a dot-named folder', async () => {
            const session = await startSession();

            const response = await request(session, '/__deepnote/client.js');

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.toString(), CLIENT_SCRIPT);
            assert.strictEqual(response.headers['content-type'], 'text/javascript; charset=utf-8');
            assert.strictEqual(response.headers['cache-control'], 'no-cache');
        });

        test("hands the client the session's token and project, with the page's origin as the API origin", async () => {
            const session = await startSession();
            const nowSeconds = Date.now() / 1000;

            const response = await request(session, '/__deepnote/api-token', {
                method: 'POST',
                headers: { origin: 'https://abc-4567.app.github.dev' }
            });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.headers['cache-control'], 'no-store');
            const { token, expiresAtSeconds, ...rest } = JSON.parse(response.body.toString()) as TokenReply;
            assert.deepStrictEqual(rest, { apiOrigin: 'https://abc-4567.app.github.dev', projectId: 'project-1' });
            assert.isNotEmpty(token);
            // In seconds, and further ahead than the minute before expiry at which the client asks again.
            assert.isAbove(expiresAtSeconds, nowSeconds + 60);
            assert.isBelow(expiresAtSeconds, nowSeconds + 24 * 60 * 60);
        });

        test('leaves the project ID out without a project', async () => {
            const session = await startSession({ project: null });

            assert.notProperty(await requestToken(session), 'projectId');
        });

        test('hands out the project setProject() sets from the next token request on', async () => {
            const session = await startSession({ project: null });

            session.setProject({ id: 'project-2', folder: Uri.file(tmp) });

            assert.strictEqual((await requestToken(session)).projectId, 'project-2');
        });

        test('answers 403 to a token request without an Origin', async () => {
            const session = await startSession();

            assert.strictEqual((await request(session, '/__deepnote/api-token', { method: 'POST' })).status, 403);
        });

        test('answers 403 to a token request from a Host that is neither loopback nor the forwarded URL', async () => {
            const session = await startSession();

            const response = await request(session, '/__deepnote/api-token', {
                method: 'POST',
                host: 'evil.example',
                headers: { origin: 'http://evil.example' }
            });

            assert.strictEqual(response.status, 403);
        });

        test('gives each session its own token', async () => {
            const first = await startSession();
            const second = await startSession();

            assert.notStrictEqual((await requestToken(first)).token, (await requestToken(second)).token);
        });

        test("mounts the API at /v2, behind the session's token", async () => {
            const session = await startSession();
            const { token } = await requestToken(session);

            const stub = await request(session, '/v2/notebooks/nb-1/app-data', {
                headers: { authorization: `Bearer ${token}` }
            });
            assert.strictEqual(stub.status, 501);
            assert.deepStrictEqual(JSON.parse(stub.body.toString()), {
                message: 'appData() is not supported in the local preview yet.'
            });
            assert.deepStrictEqual(unsupported, ['appData()']);

            assert.strictEqual((await request(session, '/v2/notebooks/nb-1/app-data')).status, 401);
        });
    });

    suite('client script swap', () => {
        test('points every tag that loads the hosted client at the bundled copy, keeping every attribute except integrity', async () => {
            const page = [
                '<!doctype html><html><head>',
                `<script src="${HOSTED}"></script>`,
                `<script src='https://deepnote.example.org/static/app-client/v1.js?v=3#top'></script>`,
                `<SCRIPT async SRC=${HOSTED} integrity="sha384-abc" crossorigin=anonymous onload="start()"></SCRIPT>`,
                '<script src="https://cdn.example.com/lib.js"></script>',
                '<script src="https://deepnote.com/static/app-client/v2.js"></script>',
                `<script data-src="${HOSTED}" src="main.js" onload="if (a > b) run()"></script>`,
                `<link rel="preload" href="${HOSTED}">`,
                '<script>window.ready = true;</script>',
                '</head></html>'
            ].join('\n');
            write('page.html', page);
            const session = await startSession();

            const served = await getText(session, '/page.html');

            assert.strictEqual(
                served,
                [
                    '<!doctype html><html><head>',
                    `${SWAPPED}</script>`,
                    `${SWAPPED}</script>`,
                    '<script async src="/__deepnote/client.js"  crossorigin=anonymous onload="start()"></SCRIPT>',
                    '<script src="https://cdn.example.com/lib.js"></script>',
                    '<script src="https://deepnote.com/static/app-client/v2.js"></script>',
                    `<script data-src="${HOSTED}" src="main.js" onload="if (a > b) run()"></script>`,
                    `<link rel="preload" href="${HOSTED}">`,
                    '<script>window.ready = true;</script>',
                    '</head></html>'
                ].join('\n')
            );
        });

        test('swaps only the opening tag when a quote sits inside an unquoted attribute value', async () => {
            const rest = '</script>\n<script src="app.js"></script>\n<p>Don\'t panic</p>';
            write('page.html', `<script data-note=it's src="${HOSTED}">${rest}`);
            const session = await startSession();

            assert.strictEqual(
                await getText(session, '/page.html'),
                `<script data-note=it's src="/__deepnote/client.js">${rest}`
            );
        });

        test('keeps an unquoted attribute value whole when it holds quotes or equals signs', async () => {
            const page = [
                `<script src="${HOSTED}" onload=start("src")></script>`,
                `<script onload=start('src') src="${HOSTED}"></script>`,
                `<script src=${HOSTED}?v=3></script>`
            ].join('\n');
            write('page.html', page);
            const session = await startSession();

            assert.strictEqual(
                await getText(session, '/page.html'),
                [
                    `<script src="/__deepnote/client.js" onload=start("src")></script>`,
                    `<script onload=start('src') src="/__deepnote/client.js"></script>`,
                    `${SWAPPED}</script>`
                ].join('\n')
            );
        });

        test('leaves a custom element whose name starts with script alone', async () => {
            const page = `<script-loader src="${HOSTED}"></script-loader>`;
            write('page.html', page);
            const session = await startSession();

            assert.strictEqual(await getText(session, '/page.html'), page);
        });

        test('swaps the tag in .htm pages, whatever the case of the extension, and in a directory index', async () => {
            write('legacy.HTM', `<script src="${HOSTED}"></script>`);
            write('sub/index.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();

            assert.strictEqual(await getText(session, '/legacy.HTM'), `${SWAPPED}</script>`);
            assert.strictEqual(await getText(session, '/sub/'), `${SWAPPED}</script>`);
        });

        test('sends the bytes outside the tag back unchanged', async () => {
            const before = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0x80, 0x0a]);
            const after = Buffer.from([0x3c, 0x2f, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0xc3, 0x28, 0xfe]);
            write('page.html', Buffer.concat([before, Buffer.from(`<script src="${HOSTED}">`), after]));
            const session = await startSession();

            const response = await request(session, '/page.html');

            assert.deepStrictEqual(response.body, Buffer.concat([before, Buffer.from(SWAPPED), after]));
        });
    });

    suite('URLs to open', () => {
        for (const hostname of ['localhost', '127.0.0.1', '0.0.0.0']) {
            test(`opens a forwarded ${hostname} URL in the built-in browser, and the server URL externally`, async () => {
                const session = await startSession();
                forwardTo(`http://${hostname}:4567/`);

                await session.resolveUrls();

                assert.strictEqual(session.browserUri.toString(true), `http://${hostname}:4567/`);
                assert.strictEqual(session.externalBrowserUri.toString(true), session.serverUrl.toString(true));
            });
        }

        test('opens an https forwarded URL in both browsers', async () => {
            const session = await startSession();
            forwardTo('https://abc-4567.app.github.dev/');

            await session.resolveUrls();

            assert.strictEqual(session.browserUri.toString(true), 'https://abc-4567.app.github.dev/');
            assert.strictEqual(session.externalBrowserUri.toString(true), 'https://abc-4567.app.github.dev/');
        });
    });
});
