import { assert } from 'chai';
import * as crypto from 'crypto';
import * as http from 'http';
import { type AddressInfo } from 'net';
import { CancellationError, CancellationTokenSource } from 'vscode';

import { buildBigQueryGoogleOAuthStrategy, createInMemoryPkceStore } from './googleOAuthProvider.node';
import { OAUTH_FLOW_TIMEOUT_MS, runOAuthFlow } from './oauthLoopbackFlow.node';

/**
 * Stub OAuth provider used by the loopback-flow tests. Exposes
 * `/oauth/authorize` and `/oauth/token` endpoints that mimic Google's
 * production endpoints enough for `passport-google-oauth20` to drive a
 * full flow.
 *
 * Configurable per-test via `setBehavior`:
 *   - `failTokenWithoutRefresh`: token endpoint omits `refresh_token`,
 *     triggering the "no refresh token" rejection in
 *     `buildBigQueryGoogleOAuthStrategy`'s verify.
 *   - `tokenStatus` / `tokenError`: simulate non-2xx token responses.
 *
 * Captures the authorize query (so tests can assert PKCE / scope /
 * access_type) and the token form (so tests can assert `code_verifier`).
 */
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

            // Validate the PKCE verifier matches the challenge issued at /authorize.
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

    /**
     * Helper: drive the full loopback flow end-to-end against the stub
     * provider. The `onListening` callback hits the loopback /auth/start
     * URL with `redirect: 'manual'`, follows the redirect to the stub's
     * /oauth/authorize (which redirects back to the loopback /auth/callback
     * with `code` + `state`), and asserts the relevant invariants along
     * the way.
     */
    async function drive(opts: {
        token?: CancellationTokenSource;
        timeoutMs?: number;
        capturedQueries?: (q: URLSearchParams) => void;
    }): Promise<{
        refreshToken: string;
    }> {
        const tokenSource = opts.token ?? new CancellationTokenSource();
        try {
            const pkceStore = createInMemoryPkceStore();
            const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'stub-client-id',
                clientSecret: 'stub-client-secret',
                store: pkceStore,
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

                    // Hit /auth/callback to drive the verify closure. Either 200
                    // (success page) or 400 (error page) — the completion promise
                    // carries the outcome.
                    const callbackResponse = await fetch(callbackLocation!);
                    await callbackResponse.text();
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
        assert.strictEqual(queries!.get('access_type'), 'offline');
        assert.strictEqual(queries!.get('prompt'), 'consent');
        assert.isString(queries!.get('state'));
        assert.isAbove(queries!.get('state')!.length, 0);
        assert.isString(queries!.get('code_challenge'));
        assert.isAbove(queries!.get('code_challenge')!.length, 0);
        assert.strictEqual(queries!.get('code_challenge_method'), 'S256');
        assert.include(queries!.get('scope') ?? '', 'https://www.googleapis.com/auth/bigquery');
    });

    test('token endpoint receives the matching code_verifier', async () => {
        await drive({});
        const form = stub.capture.tokenForm;
        assert.isDefined(form);
        const verifier = form!.get('code_verifier');
        assert.isString(verifier);
        assert.isAbove(verifier!.length, 0);
        // The stub already validated verifier→challenge inside handleToken;
        // if we made it here, the verifier matched the issued challenge.
    });

    test('two concurrent flows pick different ports', async () => {
        // Two flows running in parallel must bind distinct ephemeral ports.
        const observedPorts = new Set<number>();
        const tokenA = new CancellationTokenSource();
        const tokenB = new CancellationTokenSource();
        try {
            const pkceA = createInMemoryPkceStore();
            const pkceB = createInMemoryPkceStore();
            const { strategy: sA, completion: cA } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'c',
                clientSecret: 's',
                store: pkceA,
                authorizationURL: stub.authorizeURL,
                tokenURL: stub.tokenURL
            });
            const { strategy: sB, completion: cB } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'c',
                clientSecret: 's',
                store: pkceB,
                authorizationURL: stub.authorizeURL,
                tokenURL: stub.tokenURL
            });

            const driveOne = (strategy: typeof sA, completion: typeof cA, token: CancellationTokenSource) =>
                runOAuthFlow({
                    integrationId: 'i',
                    strategy,
                    completion,
                    token: token.token,
                    onListening: async (startUrl) => {
                        const url = new URL(startUrl);
                        observedPorts.add(parseInt(url.port, 10));
                        const startResponse = await fetch(startUrl, { redirect: 'manual' });
                        const authorizeLocation = startResponse.headers.get('location')!;
                        const authorizeResponse = await fetch(authorizeLocation, { redirect: 'manual' });
                        const callbackLocation = authorizeResponse.headers.get('location')!;
                        await fetch(callbackLocation);
                    }
                });

            await Promise.all([driveOne(sA, cA, tokenA), driveOne(sB, cB, tokenB)]);

            assert.strictEqual(observedPorts.size, 2, 'concurrent flows should bind distinct ports');
        } finally {
            tokenA.dispose();
            tokenB.dispose();
        }
    });

    test('cancellation rejects with CancellationError and closes the server', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            const pkceStore = createInMemoryPkceStore();
            const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'c',
                clientSecret: 's',
                store: pkceStore,
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
                    // Cancel after the server is up but before the user
                    // completes the flow.
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
            const pkceStore = createInMemoryPkceStore();
            const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'c',
                clientSecret: 's',
                store: pkceStore,
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

    test('missing refresh token rejects with the documented message', async () => {
        stub.setBehavior({ failTokenWithoutRefresh: true });

        try {
            await drive({});
            assert.fail('expected rejection');
        } catch (err) {
            assert.instanceOf(err, Error);
            assert.include((err as Error).message, 'No refresh token returned');
            assert.include((err as Error).message, 'myaccount.google.com/permissions');
        }
    });

    test('missing refresh token: callback page renders the documented error', async () => {
        // Catches: passport routing failures yield an unfriendly browser page
        // even though the completion promise carries the right message. We
        // assert on the HTTP status + HTML body the user actually sees.
        stub.setBehavior({ failTokenWithoutRefresh: true });

        let callbackBody: string | undefined;
        let callbackStatus: number | undefined;
        const tokenSource = new CancellationTokenSource();
        try {
            const pkceStore = createInMemoryPkceStore();
            const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'c',
                clientSecret: 's',
                store: pkceStore,
                authorizationURL: stub.authorizeURL,
                tokenURL: stub.tokenURL
            });

            const promise = runOAuthFlow({
                integrationId: 'i',
                strategy,
                completion,
                token: tokenSource.token,
                onListening: async (startUrl) => {
                    const startResponse = await fetch(startUrl, { redirect: 'manual' });
                    const authorizeLocation = startResponse.headers.get('location');
                    assert.isString(authorizeLocation);
                    const authorizeResponse = await fetch(authorizeLocation!, { redirect: 'manual' });
                    const callbackLocation = authorizeResponse.headers.get('location');
                    assert.isString(callbackLocation);
                    const callbackResponse = await fetch(callbackLocation!);
                    callbackStatus = callbackResponse.status;
                    callbackBody = await callbackResponse.text();
                }
            });

            try {
                await promise;
                assert.fail('expected rejection');
            } catch {
                // Inspect the captured body below — the runOAuthFlow rejection
                // is asserted elsewhere ("missing refresh token rejects with
                // the documented message").
            }
            assert.strictEqual(callbackStatus, 400, 'callback should render the error page status');
            assert.isString(callbackBody);
            assert.include(callbackBody!, 'No refresh token returned');
            assert.include(callbackBody!, 'myaccount.google.com/permissions');
        } finally {
            tokenSource.dispose();
        }
    });

    test('flow completes without express-session middleware (custom PKCE store works)', async () => {
        // The runOAuthFlow factory does not mount express-session anywhere —
        // a successful completion is itself proof that the custom PKCE store
        // handled the verifier round-trip without req.session.
        const result = await drive({});
        assert.strictEqual(result.refreshToken, 'test-refresh-token');
    });

    test('OAUTH_FLOW_TIMEOUT_MS is 5 minutes', () => {
        assert.strictEqual(OAUTH_FLOW_TIMEOUT_MS, 5 * 60 * 1000);
    });
});
