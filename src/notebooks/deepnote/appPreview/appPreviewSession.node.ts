import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import * as fs from 'fs/promises';
import * as http from 'http';
import { env, Uri } from 'vscode';

import { IDisposable } from '../../../platform/common/types';
import { generateUuid } from '../../../platform/common/uuid';
import { logger } from '../../../platform/logging';
import { extname, extUri } from '../../../platform/vscode-path/resources';
import { createAppPreviewApi, type AppPreviewApi, type AppPreviewOperation } from './appPreviewApi.node';
import { findNotebookById } from './appPreviewWorkspace.node';
import type { IAppPreviewRunner } from './types';

export interface AppPreviewProject {
    id: string;
    folder: Uri;
}

export interface AppPreviewSessionOptions {
    folder: Uri;
    project: AppPreviewProject | undefined;
    runner: IAppPreviewRunner;
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
// As in HTML, a quote opens a value only right after `=`; the lookahead and backreference consume a quoted value
// atomically, so a `>` inside it does not end the tag and nothing backtracks into it.
const SCRIPT_OPEN_TAG = /<script(?=[\s/>])((?:[^>="']|["']|=(?=(\s*(?:"[^"]*"|'[^']*')?))\2)*)>/gi;
const TAG_ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
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

/** Escapes everything outside printable ASCII as well, so the value survives the page's latin1 round trip. */
function escapeAttribute(value: string): string {
    let escaped = '';
    for (const character of value) {
        const codePoint = character.codePointAt(0)!;
        const isPlainAscii = codePoint >= 0x20 && codePoint <= 0x7e && !'&<>"\''.includes(character);
        escaped += isPlainAscii ? character : `&#${codePoint};`;
    }

    return escaped;
}

/**
 * `page` is the page's bytes decoded as latin1, so everything outside the swapped tags keeps its bytes whatever the
 * encoding.
 */
function swapClientScriptTags(page: string, token: string, projectId: string | undefined): string {
    const projectAttribute = projectId === undefined ? '' : ` data-deepnote-project-id="${escapeAttribute(projectId)}"`;
    const replacement = `<script src="/__deepnote/client.js" data-deepnote-token="${escapeAttribute(token)}"${projectAttribute}>`;

    return page.replace(SCRIPT_OPEN_TAG, (tag: string, attributes: string) => {
        const src = srcAttribute(attributes);

        return src !== undefined && isHostedClientUrl(src) ? replacement : tag;
    });
}

/**
 * Serves one data app folder on a loopback port the way Deepnote serves a published app, with the extension's
 * Deepnote client in place of the hosted one and a local API under `/__deepnote/v2`.
 */
export class AppPreviewSession implements IDisposable {
    private api: AppPreviewApi | undefined;
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

    /** Cancels the preview's unfinished runs, then stops its server. */
    public dispose(): void {
        this.api?.dispose();
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
        this.api = createAppPreviewApi({
            token: this.token,
            findNotebook: (notebookId) => findNotebookById(notebookId, this.project?.folder),
            onUnsupported: (operation) => this.options.onUnsupported(operation),
            runner: this.options.runner
        });
        app.use('/__deepnote/v2', this.api.router);
        app.use('/__deepnote', (_req, res) => notFound(res));
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
        const swapped = swapClientScriptTags(page, this.token, this.project?.id);

        res.set({ ...FILE_HEADERS, 'Cache-Control': 'no-store' });
        res.type(extname(requested));
        res.send(Buffer.from(swapped, 'latin1'));
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
                res.redirect(302, `/${segments.map(encodeURIComponent).join('/')}/`);

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
