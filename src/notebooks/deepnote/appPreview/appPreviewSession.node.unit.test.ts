import { serializeDeepnoteFile } from '@deepnote/blocks';
import { assert } from 'chai';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { anything, when } from 'ts-mockito';
import { Uri, type CancellationToken } from 'vscode';

import * as path from '../../../platform/vscode-path/path';
import { stubWorkspaceFsOnDisk } from '../../../test/mocks/vscodeFs';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import { createDeepnoteFile, createDeepnoteNotebook, createDeepnoteProject } from '../deepnoteTestHelpers';
import type { AppPreviewOperation } from './appPreviewApi.node';
import { AppPreviewSession, type AppPreviewProject } from './appPreviewSession.node';
import type { AppPreviewRunOutcome, IAppPreviewRunner } from './types';

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
    options: { method?: string; host?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}
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
        req.end(options.body);
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
    let runTokens: CancellationToken[];

    const runner: IAppPreviewRunner = {
        run: (_request, token) =>
            new Promise<AppPreviewRunOutcome>((resolve) => {
                runTokens.push(token);
                token.onCancellationRequested(() => resolve({ status: 'stopped', error: null, snapshotBlocks: null }));
            })
    };

    async function startSession(
        options: { folder?: string; project?: AppPreviewProject | null } = {}
    ): Promise<AppPreviewSession> {
        const project = options.project === undefined ? { id: 'project-1', folder: Uri.file(tmp) } : options.project;
        const session = new AppPreviewSession({
            folder: Uri.file(options.folder ?? appFolder),
            project: project ?? undefined,
            runner,
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
        runTokens = [];
        sessions = [];
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnote-app-preview-'));
        appFolder = path.join(tmp, 'app');
        clientScript = path.join(tmp, '.ext', 'dist', 'appClient.js');
        write('.ext/dist/appClient.js', CLIENT_SCRIPT, tmp);
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

        test('redirects a directory requested without a trailing slash to its path with one', async () => {
            const session = await startSession();

            const redirect = await request(session, '/sub?v=2');

            assert.strictEqual(redirect.status, 302);
            assert.strictEqual(redirect.headers.location, '/sub/');
        });

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
        test('serves the client script from a dot-named folder as is, so without the token', async () => {
            const session = await startSession();

            const response = await request(session, '/__deepnote/client.js');

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.toString(), CLIENT_SCRIPT);
            assert.strictEqual(response.headers['content-type'], 'text/javascript; charset=utf-8');
            assert.strictEqual(response.headers['cache-control'], 'no-cache');
        });

        test('mounts the API at /__deepnote/v2, behind the token of the pages it serves', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();
            const token = tokenOf(await getText(session, '/page.html'));

            const stub = await request(session, '/__deepnote/v2/notebooks/nb-1/app-data', {
                headers: { authorization: `Bearer ${token}` }
            });
            assert.strictEqual(stub.status, 501);
            assert.deepStrictEqual(JSON.parse(stub.body.toString()), {
                message: 'appData() is not supported in the local preview yet.'
            });
            assert.deepStrictEqual(unsupported, ['appData()']);

            assert.strictEqual((await request(session, '/__deepnote/v2/notebooks/nb-1/app-data')).status, 401);
        });

        test("answers a notebook that two files share from the session's current project folder", async () => {
            for (const copy of ['a', 'b']) {
                const notebook = createDeepnoteNotebook({ id: 'nb-1', name: `Copy ${copy}` });
                const file = createDeepnoteFile({ project: createDeepnoteProject({ notebooks: [notebook] }) });
                write(`${copy}/main.deepnote`, serializeDeepnoteFile(file), tmp);
            }
            stubWorkspaceFsOnDisk();
            when(mockedVSCodeNamespaces.workspace.findFiles('**/*.deepnote')).thenCall(async () => [
                Uri.file(path.join(tmp, 'a', 'main.deepnote')),
                Uri.file(path.join(tmp, 'b', 'main.deepnote'))
            ]);
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession({ project: { id: 'project-1', folder: Uri.file(path.join(tmp, 'b')) } });
            const token = tokenOf(await getText(session, '/page.html'));
            const notebookName = async () => {
                const response = await request(session, '/__deepnote/v2/notebooks/nb-1', {
                    headers: { authorization: `Bearer ${token}` }
                });

                return JSON.parse(response.body.toString()).notebook.name;
            };

            assert.strictEqual(await notebookName(), 'Copy b');

            session.setProject({ id: 'project-1', folder: Uri.file(path.join(tmp, 'a')) });

            assert.strictEqual(await notebookName(), 'Copy a');
        });

        test('cancels its unfinished runs when it is disposed', async () => {
            const notebook = createDeepnoteNotebook({ id: 'nb-1' });
            const file = createDeepnoteFile({ project: createDeepnoteProject({ notebooks: [notebook] }) });
            write('main.deepnote', serializeDeepnoteFile(file), tmp);
            stubWorkspaceFsOnDisk();
            when(mockedVSCodeNamespaces.workspace.findFiles('**/*.deepnote')).thenCall(async () => [
                Uri.file(path.join(tmp, 'main.deepnote'))
            ]);
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();
            const token = tokenOf(await getText(session, '/page.html'));

            const created = await request(session, '/__deepnote/v2/runs', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ notebookId: 'nb-1' })
            });
            assert.strictEqual(created.status, 202);
            assert.deepStrictEqual(
                runTokens.map((runToken) => runToken.isCancellationRequested === true),
                [false]
            );

            session.dispose();

            assert.deepStrictEqual(
                runTokens.map((runToken) => runToken.isCancellationRequested === true),
                [true]
            );
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
        });

        test('swaps only the opening tag when a quote sits inside an unquoted attribute value', async () => {
            const rest = '</script>\n<p>Don\'t panic</p>\n<script src="app.js"></script>';
            write('page.html', `<script data-note=it's src="${HOSTED}">${rest}`);
            const session = await startSession();

            const served = await getText(session, '/page.html');

            assert.strictEqual(served, `${swapped(tokenOf(served))}${rest}`);
        });

        test('leaves a custom element whose name starts with script alone', async () => {
            const page = `<script-loader src="${HOSTED}"></script-loader>`;
            write('page.html', page);
            const session = await startSession();

            assert.strictEqual(await getText(session, '/page.html'), page);
        });

        test('gives each session its own token', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const first = await startSession();
            const second = await startSession();

            assert.notStrictEqual(
                tokenOf(await getText(first, '/page.html')),
                tokenOf(await getText(second, '/page.html'))
            );
        });

        test('swaps the tag in .htm pages, whatever the case of the extension, and in a directory index', async () => {
            write('legacy.HTM', `<script src="${HOSTED}"></script>`);
            write('sub/index.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession();

            const legacy = await getText(session, '/legacy.HTM');
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

            assert.deepStrictEqual(response.body, Buffer.concat([before, Buffer.from(swapped(token)), after]));
        });

        test('escapes the project ID, and writes every character outside printable ASCII as a reference', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession({ project: { id: `p<"&'>é😀`, folder: Uri.file(tmp) } });

            const page = await getText(session, '/page.html');

            assert.strictEqual(
                page,
                `${swapped(tokenOf(page), ' data-deepnote-project-id="p&#60;&#34;&#38;&#39;&#62;&#233;&#128512;"')}</script>`
            );
        });

        test('leaves the project attribute out without a project', async () => {
            write('page.html', `<script src="${HOSTED}"></script>`);
            const session = await startSession({ project: null });

            const page = await getText(session, '/page.html');

            assert.strictEqual(page, `${swapped(tokenOf(page), '')}</script>`);
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
