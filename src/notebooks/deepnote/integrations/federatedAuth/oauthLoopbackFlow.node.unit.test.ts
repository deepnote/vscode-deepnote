import { assert } from 'chai';
import * as crypto from 'crypto';
import * as http from 'http';
import { type AddressInfo } from 'net';
import { CancellationError, CancellationTokenSource } from 'vscode';

import { runOAuthFlow } from './oauthLoopbackFlow.node';
import { buildTestStrategy } from './federatedAuthTestHelpers';

/** Stub Google OAuth provider for loopback-flow tests; exposes `/oauth/authorize` + `/oauth/token`, capturing the authorize query and token form for assertions. */
interface StubBehavior {
    failTokenWithoutRefresh?: boolean;
    tokenError?: { error: string; status: number };
}

interface StubCapture {
    authorizeQuery?: URLSearchParams;
    tokenForm?: URLSearchParams;
}

class StubOAuthProvider {
    public readonly capture: StubCapture = {};

    private behavior: StubBehavior = {};

    private codeForVerifier = new Map<string, string>(); // issued code -> code_challenge

    private server: http.Server;

    public get authorizeURL(): string {
        return `${this.baseURL}/oauth/authorize`;
    }

    public get baseURL(): string {
        const address = this.server.address() as AddressInfo;
        return `http://127.0.0.1:${address.port}`;
    }

    public get tokenURL(): string {
        return `${this.baseURL}/oauth/token`;
    }

    public constructor() {
        this.server = http.createServer((req, res) => this.handle(req, res));
    }

    public async close(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
        });
    }

    public async listen(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.server.listen(0, '127.0.0.1', () => resolve());
        });
    }

    public setBehavior(behavior: StubBehavior): void {
        this.behavior = behavior;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url ?? '/', this.baseURL);
        if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
            this.handleAuthorize(url, res);
            return;
        }
        if (url.pathname === '/oauth/token' && req.method === 'POST') {
            this.handleToken(req, res);
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    }

    private handleAuthorize(url: URL, res: http.ServerResponse): void {
        this.capture.authorizeQuery = url.searchParams;

        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const codeChallenge = url.searchParams.get('code_challenge') ?? '';

        const code = crypto.randomBytes(16).toString('hex');
        this.codeForVerifier.set(code, codeChallenge);

        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        res.statusCode = 302;
        res.setHeader('Location', callback.toString());
        res.end();
    }

    private handleToken(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            const form = new URLSearchParams(body);
            this.capture.tokenForm = form;

            if (this.behavior.tokenError) {
                res.statusCode = this.behavior.tokenError.status;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ error: this.behavior.tokenError.error }));
                return;
            }

            // Validate PKCE verifier against the challenge issued at /authorize.
            const code = form.get('code') ?? '';
            const verifier = form.get('code_verifier') ?? '';
            const expectedChallenge = this.codeForVerifier.get(code);
            const actualChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
            if (expectedChallenge !== actualChallenge) {
                res.statusCode = 400;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ error: 'invalid_grant', detail: 'PKCE verifier mismatch' }));
                return;
            }

            const responseBody: Record<string, unknown> = {
                access_token: 'stub-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                scope: 'email profile https://www.googleapis.com/auth/bigquery'
            };
            if (!this.behavior.failTokenWithoutRefresh) {
                responseBody.refresh_token = 'test-refresh-token';
            }

            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(responseBody));
        });
    }
}

suite('oauthLoopbackFlow', () => {
    let stub: StubOAuthProvider;

    setup(async () => {
        stub = new StubOAuthProvider();
        await stub.listen();
    });

    teardown(async () => {
        await stub.close();
    });

    /** Drives the full loopback flow end-to-end against the stub provider: /auth/start → /oauth/authorize → /auth/callback. */
    async function drive(opts: {
        token?: CancellationTokenSource;
        timeoutMs?: number;
        capturedQueries?: (q: URLSearchParams) => void;
        onCallback?: (response: Response, body: string) => Promise<void> | void;
        observedPorts?: Set<number>;
    }): Promise<{
        refreshToken: string;
    }> {
        const tokenSource = opts.token ?? new CancellationTokenSource();
        try {
            const { strategy, completion } = buildTestStrategy({
                authorizationURL: stub.authorizeURL,
                tokenURL: stub.tokenURL
            });

            return await runOAuthFlow({
                integrationId: 'integration-1',
                strategy,
                completion,
                token: tokenSource.token,
                timeoutMs: opts.timeoutMs,
                onListening: async (startUrl) => {
                    if (opts.observedPorts) {
                        opts.observedPorts.add(parseInt(new URL(startUrl).port, 10));
                    }

                    // Hit /auth/start to get the redirect to the stub's authorize endpoint.
                    const startResponse = await fetch(startUrl, { redirect: 'manual' });
                    assert.isAtLeast(startResponse.status, 300, 'expected redirect from /auth/start');
                    assert.isBelow(startResponse.status, 400);
                    const authorizeLocation = startResponse.headers.get('location');
                    assert.isString(authorizeLocation);

                    if (opts.capturedQueries) {
                        const parsed = new URL(authorizeLocation!);
                        opts.capturedQueries(parsed.searchParams);
                    }

                    // Follow the authorize redirect (stub returns a redirect to /auth/callback).
                    const authorizeResponse = await fetch(authorizeLocation!, { redirect: 'manual' });
                    assert.isAtLeast(authorizeResponse.status, 300);
                    assert.isBelow(authorizeResponse.status, 400);
                    const callbackLocation = authorizeResponse.headers.get('location');
                    assert.isString(callbackLocation);

                    // /auth/callback drives the verify closure; the completion promise carries the outcome.
                    const callbackResponse = await fetch(callbackLocation!);
                    const body = await callbackResponse.text();
                    if (opts.onCallback) {
                        await opts.onCallback(callbackResponse, body);
                    }
                }
            });
        } finally {
            tokenSource.dispose();
        }
    }

    test('end-to-end happy path resolves with the stub refresh token', async () => {
        const result = await drive({});
        assert.deepStrictEqual(result, { refreshToken: 'test-refresh-token' });
    });

    test('authorize redirect carries access_type=offline, prompt=consent, code_challenge, S256, scope, and state', async () => {
        let queries: URLSearchParams | undefined;
        await drive({
            capturedQueries: (q) => {
                queries = q;
            }
        });
        assert.isDefined(queries);
        assert.deepStrictEqual(
            {
                access_type: queries!.get('access_type'),
                prompt: queries!.get('prompt'),
                code_challenge_method: queries!.get('code_challenge_method')
            },
            { access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256' }
        );
        // `state` and `code_challenge` are randomly generated — verify presence + non-empty rather than exact values.
        assert.isAbove(queries!.get('state')?.length ?? 0, 0);
        assert.isAbove(queries!.get('code_challenge')?.length ?? 0, 0);
        assert.include(queries!.get('scope') ?? '', 'https://www.googleapis.com/auth/bigquery');
    });

    test('two concurrent flows pick different ports', async () => {
        const observedPorts = new Set<number>();
        await Promise.all([drive({ observedPorts }), drive({ observedPorts })]);
        assert.strictEqual(observedPorts.size, 2, 'concurrent flows should bind distinct ports');
    });

    test('cancellation rejects with CancellationError and closes the server', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            const { strategy, completion } = buildTestStrategy({
                authorizationURL: stub.authorizeURL,
                tokenURL: stub.tokenURL
            });

            let observedStartUrl!: string;

            const flowPromise = runOAuthFlow({
                integrationId: 'i',
                strategy,
                completion,
                token: tokenSource.token,
                onListening: async (startUrl) => {
                    observedStartUrl = startUrl;
                    // Cancel after listen() but before user consent.
                    tokenSource.cancel();
                }
            });

            try {
                await flowPromise;
                assert.fail('expected rejection');
            } catch (err) {
                assert.instanceOf(err, CancellationError);
            }

            // Server should be torn down — a fetch attempt should fail.
            try {
                await fetch(observedStartUrl);
                assert.fail('expected fetch to fail against a closed server');
            } catch (err) {
                assert.instanceOf(err, Error);
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('timeout rejects with a timeout error', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            const { strategy, completion } = buildTestStrategy({
                authorizationURL: stub.authorizeURL,
                tokenURL: stub.tokenURL
            });

            const flowPromise = runOAuthFlow({
                integrationId: 'i',
                strategy,
                completion,
                token: tokenSource.token,
                timeoutMs: 100,
                onListening: async () => {
                    // Do nothing — let the flow hit the timeout.
                }
            });

            try {
                await flowPromise;
                assert.fail('expected rejection');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.match((err as Error).message, /timed out/i);
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('missing refresh token rejects and renders the documented error page', async () => {
        // Catches: passport routing yielding an unfriendly browser page even though completion has the right message.
        stub.setBehavior({ failTokenWithoutRefresh: true });

        let callbackBody: string | undefined;
        let callbackStatus: number | undefined;

        try {
            await drive({
                onCallback: (response, body) => {
                    callbackStatus = response.status;
                    callbackBody = body;
                }
            });
            assert.fail('expected rejection');
        } catch (err) {
            assert.instanceOf(err, Error);
            assert.include((err as Error).message, 'No refresh token returned');
            assert.include((err as Error).message, 'myaccount.google.com/permissions');
        }

        assert.strictEqual(callbackStatus, 400, 'callback should render the error page status');
        assert.isString(callbackBody);
        assert.include(callbackBody!, 'No refresh token returned');
        assert.include(callbackBody!, 'myaccount.google.com/permissions');
    });
});
