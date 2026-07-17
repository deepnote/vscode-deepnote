import { assert } from 'chai';
import * as http from 'http';
import { type AddressInfo } from 'net';
import { anything, when } from 'ts-mockito';
import { CancellationError, CancellationTokenSource } from 'vscode';

import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../../test/vscode-mock';
import { runOAuthFlow } from './oauthLoopbackFlow.node';

/** Stub Google `/token` endpoint for loopback-flow tests; captures the form body for assertions. */
interface StubBehavior {
    body?: Record<string, unknown>;
    status?: number;
}

class StubTokenEndpoint {
    public capturedForm?: URLSearchParams;

    private behavior: StubBehavior = {};

    private server: http.Server;

    public get url(): string {
        const address = this.server.address() as AddressInfo;

        return `http://127.0.0.1:${address.port}/oauth/token`;
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
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            this.capturedForm = new URLSearchParams(body);

            res.statusCode = this.behavior.status ?? 200;
            res.setHeader('content-type', 'application/json');
            res.end(
                JSON.stringify(
                    this.behavior.body ?? {
                        access_token: 'stub-access-token',
                        refresh_token: 'stub-refresh-token',
                        token_type: 'Bearer',
                        expires_in: 3600
                    }
                )
            );
        });
    }
}

suite('oauthLoopbackFlow', () => {
    let stub: StubTokenEndpoint;

    setup(async () => {
        resetVSCodeMocks();
        // In local VS Code, asExternalUri is effectively a passthrough — mirror that here so loopback URLs flow unchanged.
        when(mockedVSCodeNamespaces.env.asExternalUri(anything())).thenCall((uri) => Promise.resolve(uri));

        stub = new StubTokenEndpoint();
        await stub.listen();
    });

    teardown(async () => {
        await stub.close();
    });

    test('end-to-end happy path: callback delivers code, code is exchanged, refresh token returns', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            const result = await runOAuthFlow({
                clientId: 'my-client-id',
                clientSecret: 'my-client-secret',
                codeVerifier: 'pkce-verifier',
                integrationId: 'integration-1',
                onListening: async (externalCallbackUrl) => {
                    // Simulate the browser landing on the loopback callback after deepnote.com → Google → deepnote.com → loopback.
                    const callbackWithParams = new URL(externalCallbackUrl);
                    callbackWithParams.searchParams.set('code', 'google-auth-code');
                    callbackWithParams.searchParams.set('state', 'my-state');
                    const response = await fetch(callbackWithParams.toString());
                    assert.strictEqual(response.status, 200);
                },
                redirectUri: 'https://deepnote.com/auth/bigquery/google-oauth-callback',
                state: 'my-state',
                token: tokenSource.token,
                tokenUrl: stub.url
            });

            assert.deepStrictEqual(result, { refreshToken: 'stub-refresh-token' });

            // Verify the exchange used the right parameters.
            assert.isDefined(stub.capturedForm);
            assert.strictEqual(stub.capturedForm!.get('grant_type'), 'authorization_code');
            assert.strictEqual(stub.capturedForm!.get('code'), 'google-auth-code');
            assert.strictEqual(stub.capturedForm!.get('code_verifier'), 'pkce-verifier');
            assert.strictEqual(
                stub.capturedForm!.get('redirect_uri'),
                'https://deepnote.com/auth/bigquery/google-oauth-callback'
            );
        } finally {
            tokenSource.dispose();
        }
    });

    test('state mismatch: callback rejects with a clear error and renders the error page', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            let callbackStatus: number | undefined;
            let callbackBody: string | undefined;

            try {
                await runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: 'i',
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        url.searchParams.set('code', 'x');
                        url.searchParams.set('state', 'NOT-THE-EXPECTED-STATE');
                        const response = await fetch(url.toString());
                        callbackStatus = response.status;
                        callbackBody = await response.text();
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state: 'expected-state',
                    token: tokenSource.token,
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.include(err.message, '`state` did not match');
            }

            assert.strictEqual(callbackStatus, 400);
            assert.isString(callbackBody);
            assert.include(callbackBody!, '`state` did not match');
        } finally {
            tokenSource.dispose();
        }
    });

    test('missing code: callback rejects and renders the error page', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            try {
                await runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: 'i',
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        url.searchParams.set('state', 'expected-state');
                        const response = await fetch(url.toString());
                        assert.strictEqual(response.status, 400);
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state: 'expected-state',
                    token: tokenSource.token,
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.include(err.message, 'missing `code`');
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('provider error (?error=access_denied): callback rejects with the provider message', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            let callbackStatus: number | undefined;
            let callbackBody: string | undefined;

            try {
                await runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: 'i',
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        url.searchParams.set('error', 'access_denied');
                        url.searchParams.set('error_description', 'User denied access');
                        url.searchParams.set('state', 'expected-state');
                        const response = await fetch(url.toString());
                        callbackStatus = response.status;
                        callbackBody = await response.text();
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state: 'expected-state',
                    token: tokenSource.token,
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.include(err.message, 'access_denied');
                assert.include(err.message, 'User denied access');
            }

            assert.strictEqual(callbackStatus, 400);
            assert.isString(callbackBody);
            assert.include(callbackBody!, 'access_denied');
        } finally {
            tokenSource.dispose();
        }
    });

    test('provider error without description: callback rejects with just the error code', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            try {
                await runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: 'i',
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        url.searchParams.set('error', 'server_error');
                        url.searchParams.set('state', 'expected-state');
                        await fetch(url.toString());
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state: 'expected-state',
                    token: tokenSource.token,
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.include(err.message, 'server_error');
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('state mismatch with provider error: state check wins so a CSRF attempt cannot mask its identity behind an error', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            try {
                await runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: 'i',
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        url.searchParams.set('error', 'access_denied');
                        url.searchParams.set('state', 'NOT-THE-EXPECTED-STATE');
                        await fetch(url.toString());
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state: 'expected-state',
                    token: tokenSource.token,
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.include(err.message, '`state` did not match');
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('token-exchange failure: callback rejects and renders the error page', async () => {
        stub.setBehavior({ status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } });

        const tokenSource = new CancellationTokenSource();
        try {
            let callbackStatus: number | undefined;

            try {
                await runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: 'i',
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        url.searchParams.set('code', 'x');
                        url.searchParams.set('state', 'matching-state');
                        const response = await fetch(url.toString());
                        callbackStatus = response.status;
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state: 'matching-state',
                    token: tokenSource.token,
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
            }

            assert.strictEqual(callbackStatus, 400);
        } finally {
            tokenSource.dispose();
        }
    });

    test('cancellation: rejects with CancellationError and closes the server', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            let observedCallbackUrl!: string;

            const flowPromise = runOAuthFlow({
                clientId: 'c',
                clientSecret: 's',
                codeVerifier: 'v',
                integrationId: 'i',
                onListening: async (externalCallbackUrl) => {
                    observedCallbackUrl = externalCallbackUrl;
                    // Cancel after listen() but before any callback.
                    tokenSource.cancel();
                },
                redirectUri: 'https://deepnote.com/cb',
                state: 'state',
                token: tokenSource.token,
                tokenUrl: stub.url
            });

            try {
                await flowPromise;
                assert.fail('expected rejection');
            } catch (err) {
                assert.instanceOf(err, CancellationError);
            }

            // Server should be torn down — a fetch attempt should fail.
            try {
                await fetch(observedCallbackUrl);
                assert.fail('expected fetch to fail against a closed server');
            } catch (err) {
                assert.instanceOf(err, Error);
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('timeout: rejects with a timeout error', async () => {
        const tokenSource = new CancellationTokenSource();
        try {
            const flowPromise = runOAuthFlow({
                clientId: 'c',
                clientSecret: 's',
                codeVerifier: 'v',
                integrationId: 'i',
                onListening: async () => {
                    // Do nothing — let the flow hit the timeout.
                },
                redirectUri: 'https://deepnote.com/cb',
                state: 'state',
                timeoutMs: 100,
                token: tokenSource.token,
                tokenUrl: stub.url
            });

            try {
                await flowPromise;
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.match(err.message, /timed out/i);
            }
        } finally {
            tokenSource.dispose();
        }
    });

    test('two concurrent flows pick different ports', async () => {
        const ports = new Set<number>();
        const tokenSourceA = new CancellationTokenSource();
        const tokenSourceB = new CancellationTokenSource();
        try {
            const driveOne = async (token: CancellationTokenSource, state: string) => {
                return runOAuthFlow({
                    clientId: 'c',
                    clientSecret: 's',
                    codeVerifier: 'v',
                    integrationId: state,
                    onListening: async (externalCallbackUrl) => {
                        const url = new URL(externalCallbackUrl);
                        ports.add(parseInt(url.port, 10));
                        url.searchParams.set('code', `code-${state}`);
                        url.searchParams.set('state', state);
                        await fetch(url.toString());
                    },
                    redirectUri: 'https://deepnote.com/cb',
                    state,
                    token: token.token,
                    tokenUrl: stub.url
                });
            };

            await Promise.all([driveOne(tokenSourceA, 'state-a'), driveOne(tokenSourceB, 'state-b')]);

            assert.strictEqual(ports.size, 2, 'concurrent flows should bind distinct ports');
        } finally {
            tokenSourceA.dispose();
            tokenSourceB.dispose();
        }
    });
});
