import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import * as fs from 'fs/promises';
import * as http from 'http';
import { env, Uri } from 'vscode';

import { IDisposable } from '../../../platform/common/types';
import { generateUuid } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import { extname, extUri } from '../../../platform/vscode-path/resources';
import { createAppPreviewApi, type AppPreviewOperation } from './appPreviewApi.node';

export interface AppPreviewProject {
    id: string;
    folder: Uri;
}

export interface AppPreviewSessionOptions {
    folder: Uri;
    project: AppPreviewProject | undefined;
    scripts: { appClient: Uri };
    onUnsupported(operation: AppPreviewOperation): void;
}

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
// Hostnames whose forwarded URL `env.openExternal` would forward a second time, as a remote port.
const LOCAL_BROWSER_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0'];

// Deepnote's static-files headers, without its `frame-ancestors`: the Simple Browser frames the page inside a webview,
// and `frame-ancestors` must allow every frame of that chain.
const FILE_HEADERS = {
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:"
};

const HOSTED_CLIENT_PATH = '/static/app-client/v1.js';
const CLIENT_SRC_ATTRIBUTE = 'src="/__deepnote/client.js"';
// The token is valid for the whole session; when this runs out, the client asks again and gets the same token.
const TOKEN_LIFETIME_SECONDS = 60 * 60;
// As in HTML, a quote opens a value only right after `=`; the lookahead and backreference consume a quoted value
// atomically, so a `>` inside it does not end the tag and nothing backtracks into it.
const SCRIPT_OPEN_TAG = /<script(?=[\s/>])((?:[^>="']|["']|=(?=(\s*(?:"[^"]*"|'[^']*')?))\2)*)>/gi;
// Browsers end an unquoted value only at whitespace or `>`, keeping any quote or `=` inside it.
const TAG_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const HTML_PAGE = /\.html?$/i;

function notFound(res: Response): void {
    res.status(404).type('text/plain').send('Not found');
}

function onSendError(res: Response): (error: Error | undefined) => void {
    return (error) => {
        if (error && !res.headersSent) {
            notFound(res);
        }
    };
}

function decodePathSegments(urlPath: string): string[] | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return undefined;
    }

    const segments = decoded.split('/').filter((segment) => segment !== '');
    if (decoded.includes('\0') || segments.includes('..')) {
        return undefined;
    }

    return segments;
}

function hostnameOf(uri: Uri): string {
    return new URL(uri.toString(true)).hostname.toLowerCase();
}

function srcAttribute(attributes: string): string | undefined {
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(TAG_ATTRIBUTE)) {
        if (name.toLowerCase() === 'src') {
            return doubleQuoted ?? singleQuoted ?? unquoted ?? '';
        }
    }

    return undefined;
}

function isHostedClientUrl(src: string): boolean {
    return src.trim().split(/[?#]/, 1)[0].endsWith(HOSTED_CLIENT_PATH);
}

/** `integrity` is a hash of the hosted file, which the bundled copy need not match. */
function clientAttribute(attribute: string, name: string): string {
    switch (name.toLowerCase()) {
        case 'src':
            return CLIENT_SRC_ATTRIBUTE;
        case 'integrity':
            return '';
        default:
            return attribute;
    }
}

/**
 * `page` is the page's bytes decoded as latin1, so everything outside the swapped tags keeps its bytes whatever the
 * encoding.
 */
function swapClientScriptTags(page: string): string {
    return page.replace(SCRIPT_OPEN_TAG, (tag: string, attributes: string) => {
        const src = srcAttribute(attributes);

        return src !== undefined && isHostedClientUrl(src)
            ? `<script${attributes.replace(TAG_ATTRIBUTE, clientAttribute)}>`
            : tag;
    });
}

/**
 * Serves one data app folder on a loopback port the way Deepnote serves a published app, with the extension's copy of
 * Deepnote's client in place of the hosted one, the token endpoint the client asks first, and a local API at `/v2`.
 */
export class AppPreviewSession implements IDisposable {
    private project: AppPreviewProject | undefined;
    private server: http.Server | undefined;
    private serverUri: Uri | undefined;
    private readonly token = generateUuid();
    private url: Uri | undefined;

    constructor(private readonly options: AppPreviewSessionOptions) {
        this.project = options.project;
    }

    /** The URL to open in VS Code's built-in browser. Set by `resolveUrls()`. */
    public get browserUri(): Uri {
        return this.resolvedUrl();
    }

    /**
     * The URL to pass to `env.openExternal`, which forwards loopback URLs itself, treating their port as a remote
     * port. A forwarded loopback URL names a local port, so the server's own URL is passed instead.
     */
    public get externalBrowserUri(): Uri {
        const url = this.resolvedUrl();

        return LOCAL_BROWSER_HOSTNAMES.includes(hostnameOf(url)) ? this.serverUrl : url;
    }

    /** The loopback URL the server listens on. Set by `start()`. */
    public get serverUrl(): Uri {
        if (!this.serverUri) {
            throw new Error('The app preview server has not started.');
        }

        return this.serverUri;
    }

    public dispose(): void {
        const server = this.server;
        this.server = undefined;
        if (!server) {
            return;
        }

        try {
            server.closeAllConnections();
            server.close();
        } catch (error) {
            logger.warn('AppPreviewSession: Error while stopping the preview server', error);
        }
    }

    /**
     * Resolves the URL the user's side can reach from `env.asExternalUri`. Its result must not be kept: the user
     * can stop or move the forwarding in the Ports view, so it is resolved again before every open.
     */
    public async resolveUrls(): Promise<void> {
        this.url = await env.asExternalUri(this.serverUrl);
    }

    public setProject(project: AppPreviewProject | undefined): void {
        this.project = project;
    }

    public async start(): Promise<void> {
        const server = http.createServer(this.createApp());
        this.server = server;

        // Persistent handler: an 'error' with no listener is re-thrown as an uncaught exception that crashes the host.
        server.on('error', (error) => logger.error('AppPreviewSession: HTTP server error', error));

        server.listen(0, '127.0.0.1');

        const port = await new Promise<number>((resolve, reject) => {
            let onStartupError: (error: Error) => void = () => undefined;
            let onListening: () => void = () => undefined;
            onStartupError = (error: Error) => {
                server.removeListener('listening', onListening);
                reject(error);
            };
            onListening = () => {
                server.removeListener('error', onStartupError);
                const address = server.address();
                if (!address || typeof address === 'string') {
                    reject(new Error('The app preview server did not bind a port.'));

                    return;
                }
                resolve(address.port);
            };
            server.once('error', onStartupError);
            server.once('listening', onListening);
        });

        this.serverUri = Uri.parse(`http://127.0.0.1:${port}/`);
        logger.info(`AppPreviewSession: Serving ${this.options.folder.fsPath} on ${this.serverUri.toString(true)}`);
    }

    private checkHost(req: Request, res: Response, next: NextFunction): void {
        const hostname = req.hostname?.toLowerCase();
        const allowed = this.url ? [...LOOPBACK_HOSTNAMES, hostnameOf(this.url)] : LOOPBACK_HOSTNAMES;
        if (hostname === undefined || !allowed.includes(hostname)) {
            res.status(403).type('text/plain').send('Forbidden');

            return;
        }
        next();
    }

    private createApp(): Express {
        const app = express();

        app.use((req, res, next) => this.checkHost(req, res, next));
        app.get('/__deepnote/client.js', (_req, res) => {
            res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.sendFile(this.options.scripts.appClient.fsPath, { dotfiles: 'allow' }, (error) => {
                if (error) {
                    logger.warn('AppPreviewSession: Could not send the app preview client script', error);
                }
                onSendError(res)(error);
            });
        });
        app.post('/__deepnote/api-token', (req, res) => this.sendToken(req, res));
        app.use('/__deepnote', (_req, res) => notFound(res));
        app.use(
            '/v2',
            createAppPreviewApi({
                token: this.token,
                onUnsupported: (operation) => this.options.onUnsupported(operation)
            })
        );
        app.use((req, res) => this.serveFolder(req, res));

        return app;
    }

    private resolvedUrl(): Uri {
        if (!this.url) {
            throw new Error('The app preview URLs have not been resolved.');
        }

        return this.url;
    }

    private async sendPage(res: Response, requested: Uri, realPath: string): Promise<void> {
        const page = (await fs.readFile(realPath)).toString('latin1');

        res.set({ ...FILE_HEADERS, 'Cache-Control': 'no-store' });
        res.type(extname(requested));
        res.send(Buffer.from(swapClientScriptTags(page), 'latin1'));
    }

    /**
     * Answers the client as Deepnote answers it for a public app. The client calls the API on `apiOrigin`, which must
     * be the page's origin as the browser sees it, and a forwarded URL can make that differ from the server's own.
     */
    private sendToken(req: Request, res: Response): void {
        const pageOrigin = req.get('origin');
        if (!pageOrigin) {
            res.status(403).type('text/plain').send('Forbidden');

            return;
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            token: this.token,
            apiOrigin: pageOrigin,
            expiresAtSeconds: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
            // The bundled client ignores this; the version that adds `dataframe()` will read the project from here.
            ...(this.project ? { projectId: this.project.id } : {})
        });
    }

    private async serveFolder(req: Request, res: Response): Promise<void> {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.status(405).set('Allow', 'GET, HEAD').type('text/plain').send('Method not allowed');

            return;
        }

        const segments = decodePathSegments(req.path);
        // Express matches the reserved `/__deepnote` prefix before decoding, so an encoded one gets here.
        if (!segments || segments[0]?.toLowerCase() === '__deepnote') {
            notFound(res);

            return;
        }

        const isDirectoryPath = req.path.endsWith('/');
        const requested = Uri.joinPath(this.options.folder, ...segments, ...(isDirectoryPath ? ['index.html'] : []));

        try {
            const [realFolder, realPath] = await Promise.all([
                fs.realpath(this.options.folder.fsPath),
                fs.realpath(requested.fsPath)
            ]);
            if (!extUri.isEqualOrParent(Uri.file(realPath), Uri.file(realFolder))) {
                notFound(res);

                return;
            }

            const stat = await fs.stat(realPath);
            if (stat.isDirectory() && !isDirectoryPath) {
                // Raw, as Deepnote keeps it: re-serializing `req.query` would change the client's encoding.
                const queryStart = req.originalUrl.indexOf('?');
                const query = queryStart === -1 ? '' : req.originalUrl.slice(queryStart);

                res.redirect(302, `/${segments.map(encodeURIComponent).join('/')}/${query}`);

                return;
            }
            if (!stat.isFile()) {
                notFound(res);

                return;
            }

            if (HTML_PAGE.test(requested.path)) {
                await this.sendPage(res, requested, realPath);

                return;
            }

            res.set({ ...FILE_HEADERS, 'Cache-Control': 'private, no-cache' });
            res.sendFile(realPath, { dotfiles: 'allow' }, onSendError(res));
        } catch (error) {
            logger.debug('AppPreviewSession: Could not serve a requested path', error);
            if (!res.headersSent) {
                notFound(res);
            }
        }
    }
}
