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
const CLIENT_SCRIPT = '/* the extension client */\n';
const HOSTED = 'https://deepnote.com/static/app-client/v1.js';

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

function tokenOf(page: string): string {
    const match = /data-deepnote-token="([^"]+)"/.exec(page);
    assert.isNotNull(match, 'the page carries no token');

    return match![1];
}

suite('AppPreviewSession', () => {
    let tmp: string;
    let appFolder: string;
    let clientScript: string;
    let sessions: AppPreviewSession[];
    let unsupported: AppPreviewOperation[];

    /** Starts a session on `folder`, by default the app folder of project `project-1`; `project: null` for none. */
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
        clientScript = path.join(tmp, '.ext', 'dist', 'appClient.js');
        write('.ext/dist/appClient.js', CLIENT_SCRIPT, tmp);
        write('index.html', '<h1>home</h1>');
        write('sub/index.html', '<h1>sub</h1>');
        write('my file.txt', 'spaced');
        write('assets/app.css', 'body { color: red; }');
        write('__deepnote/x.js', 'shadowed');
        write('secret.txt', 'outside', `${appFolder}-other`);
        fs.symlinkSync(path.join(`${appFolder}-other`, 'secret.txt'), path.join(appFolder, 'escape.txt'));
    });

    teardown(() => {
        sessions.forEach((session) => session.dispose());
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    suite('files', () => {
        test('serves index.html for / and /sub/, and redirects /sub to /sub/', async () => {
            const session = await startSession();

            assert.strictEqual(await getText(session, '/'), '<h1>home</h1>');
            assert.strictEqual(await getText(session, '/sub/'), '<h1>sub</h1>');
            assert.strictEqual(await getText(session, '/sub/?v=2'), '<h1>sub</h1>');

            const redirect = await request(session, '/sub?v=2');
            assert.strictEqual(redirect.status, 302);
            assert.strictEqual(redirect.headers.location, '/sub/');
        });

        test('serves files by their exact decoded names', async () => {
            const session = await startSession();

            assert.strictEqual(await getText(session, '/my%20file.txt'), 'spaced');
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

        test('answers 404 to .. segments, NUL, missing files, __deepnote paths and symlinks out of the folder', async () => {
            const session = await startSession();

            for (const urlPath of [
                '/sub/../../app-other/secret.txt',
                '/sub/../index.html',
                '/%2e%2e/app-other/secret.txt',
                '/sub%2f..%2f..%2f./app-other/secret.txt',
                '/index.html%00.css',
                '/missing.txt',
                '/sub/missing/',
                '/__deepnote/x.js',
                '/__deepnote',
                '/escape.txt'
            ]) {
                const response = await request(session, urlPath);
                assert.strictEqual(response.status, 404, urlPath);
                assert.strictEqual(response.body.toString(), 'Not found', urlPath);
            }
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
        test('serves the client script from a dot-named folder, without the token', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();
            const token = tokenOf(await getText(session, '/page.html'));

            const response = await request(session, '/__deepnote/client.js');

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.toString(), CLIENT_SCRIPT);
            assert.strictEqual(response.headers['content-type'], 'text/javascript; charset=utf-8');
            assert.strictEqual(response.headers['cache-control'], 'no-cache');
            assert.notInclude(response.body.toString(), token);
        });

        test('mounts the API at /__deepnote/v2, and answers 404 under other /__deepnote/ paths', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();
            const token = tokenOf(await getText(session, '/page.html'));

            const stub = await request(session, '/__deepnote/v2/notebooks/nb-1', {
                headers: { authorization: `Bearer ${token}` }
            });
            assert.strictEqual(stub.status, 501);
            assert.deepStrictEqual(JSON.parse(stub.body.toString()), {
                message: 'inputs() is not supported in the local preview yet.'
            });
            assert.deepStrictEqual(unsupported, ['inputs()']);

            assert.strictEqual((await request(session, '/__deepnote/v2/notebooks/nb-1')).status, 401);
            assert.strictEqual((await request(session, '/__deepnote/other')).status, 404);
        });
    });

    suite('client script swap', () => {
        const swapped = (token: string, projectAttribute = ' data-deepnote-project-id="project-1"') =>
            `<script src="/__deepnote/client.js" data-deepnote-token="${token}"${projectAttribute}>`;

        test('swaps every tag that loads the hosted client, whatever its host, query, quotes or attributes', async () => {
            const page = [
                '<!doctype html><html><head>',
                `<script src="${HOSTED}"></script>`,
                `<script src='https://deepnote.example.org/static/app-client/v1.js?v=3#top'></script>`,
                `<SCRIPT async SRC=${HOSTED} integrity="sha384-abc" crossorigin=anonymous></SCRIPT>`,
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
            const token = tokenOf(served);

            assert.strictEqual(
                served,
                [
                    '<!doctype html><html><head>',
                    `${swapped(token)}</script>`,
                    `${swapped(token)}</script>`,
                    `${swapped(token)}</SCRIPT>`,
                    '<script src="https://cdn.example.com/lib.js"></script>',
                    '<script src="https://deepnote.com/static/app-client/v2.js"></script>',
                    `<script data-src="${HOSTED}" src="main.js" onload="if (a > b) run()"></script>`,
                    `<link rel="preload" href="${HOSTED}">`,
                    '<script>window.ready = true;</script>',
                    '</head></html>'
                ].join('\n')
            );
            assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        });

        test('swaps the tag in .htm pages and in a directory index', async () => {
            write('legacy.htm', `<script src="${HOSTED}"></script>`);
            write('sub/index.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();

            const legacy = await getText(session, '/legacy.htm');
            assert.strictEqual(legacy, `${swapped(tokenOf(legacy))}</script>`);
            const index = await getText(session, '/sub/');
            assert.strictEqual(index, `${swapped(tokenOf(index))}</script>`);
        });

        test('sends the bytes outside the tag back unchanged', async () => {
            const before = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0x80, 0x0a]);
            const after = Buffer.from([0x3c, 0x2f, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0xc3, 0x28, 0xfe]);
            write('page.html', Buffer.concat([before, Buffer.from(`<script src="${HOSTED}">`), after]));
            const session = await startSession();

            const response = await request(session, '/page.html');
            const token = tokenOf(response.body.toString('latin1'));

            assert.isTrue(
                response.body.equals(Buffer.concat([before, Buffer.from(swapped(token)), after])),
                response.body.toString('latin1')
            );
        });

        test('escapes the project ID, and leaves the attribute out without a project', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const escaped = await startSession({ project: { id: `p<"&'>é😀`, folder: Uri.file(tmp) } });
            const withoutProject = await startSession({ project: null });

            const page = await getText(escaped, '/page.html');
            assert.strictEqual(
                page,
                `${swapped(tokenOf(page), ' data-deepnote-project-id="p&#60;&#34;&#38;&#39;&#62;&#233;&#128512;"')}</script>`
            );
            const bare = await getText(withoutProject, '/page.html');
            assert.strictEqual(bare, `${swapped(tokenOf(bare), '')}</script>`);
        });

        test('serves the project set by setProject() from the next page on', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession({ project: null });
            assert.notInclude(await getText(session, '/page.html'), 'data-deepnote-project-id');

            session.setProject({ id: 'project-2', folder: Uri.file(tmp) });

            const page = await getText(session, '/page.html');
            assert.strictEqual(page, `${swapped(tokenOf(page), ' data-deepnote-project-id="project-2"')}</script>`);
        });
    });

    suite('URLs to open', () => {
        test('opens a forwarded loopback URL in the built-in browser, and the server URL externally', async () => {
            const session = await startSession();
            forwardTo('http://localhost:4567/');

            await session.resolveUrls();

            assert.strictEqual(session.browserUri.toString(true), 'http://localhost:4567/');
            assert.strictEqual(session.externalBrowserUri.toString(true), session.serverUrl.toString(true));
            assert.notStrictEqual(session.serverUrl.toString(true), 'http://localhost:4567/');
        });

        test('opens an https forwarded URL in both browsers', async () => {
            const session = await startSession();
            forwardTo('https://abc-4567.app.github.dev/');

            await session.resolveUrls();

            assert.strictEqual(session.browserUri.toString(true), 'https://abc-4567.app.github.dev/');
            assert.strictEqual(session.externalBrowserUri.toString(true), 'https://abc-4567.app.github.dev/');
        });
    });
});
