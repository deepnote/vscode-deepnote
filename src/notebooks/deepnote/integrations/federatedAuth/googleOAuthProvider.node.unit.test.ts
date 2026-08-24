import { assert } from 'chai';
import * as crypto from 'crypto';
import * as http from 'http';
import { type AddressInfo } from 'net';

import { InvalidClientError, InvalidGrantError } from './federatedAuthTokenStorage.node';
import {
    GOOGLE_BIGQUERY_SCOPES,
    exchangeAuthorizationCode,
    generateOAuthStateNonce,
    generatePkcePair
} from './googleOAuthProvider.node';

interface StubBehavior {
    body?: Record<string, unknown>;
    status?: number;
}

class StubTokenEndpoint {
    public lastFormBody?: URLSearchParams;

    public lastAuthorizationHeader?: string;

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
            this.lastAuthorizationHeader = req.headers.authorization;
            this.lastFormBody = new URLSearchParams(body);

            const status = this.behavior.status ?? 200;
            const responseBody = this.behavior.body ?? {
                access_token: 'stub-access-token',
                refresh_token: 'stub-refresh-token',
                token_type: 'Bearer',
                expires_in: 3600
            };
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(responseBody));
        });
    }
}

suite('googleOAuthProvider', () => {
    suite('GOOGLE_BIGQUERY_SCOPES', () => {
        test('exposes email, profile, and the bigquery scope (no openid)', () => {
            assert.deepStrictEqual(
                [...GOOGLE_BIGQUERY_SCOPES],
                ['email', 'profile', 'https://www.googleapis.com/auth/bigquery']
            );
        });
    });

    suite('generatePkcePair', () => {
        test('returns base64url-encoded verifier and challenge', () => {
            const { challenge, verifier } = generatePkcePair();
            // base64url alphabet: A-Z, a-z, 0-9, -, _ (no padding).
            assert.match(verifier, /^[A-Za-z0-9_-]+$/);
            assert.match(challenge, /^[A-Za-z0-9_-]+$/);
            // 32 bytes → 43 base64url chars (no padding).
            assert.strictEqual(verifier.length, 43);
            assert.strictEqual(challenge.length, 43);
        });

        test('challenge is SHA256(verifier) in base64url', () => {
            const { challenge, verifier } = generatePkcePair();
            const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
            assert.strictEqual(challenge, expected);
        });

        test('successive calls produce distinct verifiers', () => {
            const pairs = Array.from({ length: 5 }, () => generatePkcePair().verifier);
            assert.strictEqual(new Set(pairs).size, 5);
        });
    });

    suite('generateOAuthStateNonce', () => {
        test('produces a non-empty base64url string', () => {
            const nonce = generateOAuthStateNonce();
            assert.match(nonce, /^[A-Za-z0-9_-]+$/);
            assert.isAbove(nonce.length, 0);
        });

        test('successive calls produce distinct values', () => {
            const nonces = Array.from({ length: 5 }, () => generateOAuthStateNonce());
            assert.strictEqual(new Set(nonces).size, 5);
        });
    });

    suite('exchangeAuthorizationCode', () => {
        let stub: StubTokenEndpoint;

        setup(async () => {
            stub = new StubTokenEndpoint();
            await stub.listen();
        });

        teardown(async () => {
            await stub.close();
        });

        test('happy path: sends Basic auth + form body, returns refresh + access tokens', async () => {
            const result = await exchangeAuthorizationCode({
                clientId: 'my-client-id',
                clientSecret: 'my-client-secret',
                code: 'authorization-code-from-google',
                codeVerifier: 'pkce-verifier-value',
                redirectUri: 'https://deepnote.com/auth/bigquery/google-oauth-callback',
                tokenUrl: stub.url
            });

            assert.deepStrictEqual(result, {
                accessToken: 'stub-access-token',
                refreshToken: 'stub-refresh-token'
            });

            const expectedBasic = Buffer.from('my-client-id:my-client-secret').toString('base64');
            assert.strictEqual(stub.lastAuthorizationHeader, `Basic ${expectedBasic}`);

            assert.isDefined(stub.lastFormBody);
            assert.strictEqual(stub.lastFormBody!.get('grant_type'), 'authorization_code');
            assert.strictEqual(stub.lastFormBody!.get('code'), 'authorization-code-from-google');
            assert.strictEqual(stub.lastFormBody!.get('code_verifier'), 'pkce-verifier-value');
            assert.strictEqual(
                stub.lastFormBody!.get('redirect_uri'),
                'https://deepnote.com/auth/bigquery/google-oauth-callback'
            );
        });

        test('throws InvalidGrantError on `invalid_grant` response', async () => {
            stub.setBehavior({ status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } });

            try {
                await exchangeAuthorizationCode({
                    clientId: 'c',
                    clientSecret: 's',
                    code: 'x',
                    codeVerifier: 'v',
                    redirectUri: 'https://deepnote.com/cb',
                    tokenUrl: stub.url
                });
                assert.fail('expected InvalidGrantError');
            } catch (err) {
                assert(err instanceof InvalidGrantError);
            }
        });

        test('throws InvalidClientError on `invalid_client` response', async () => {
            stub.setBehavior({ status: 401, body: { error: 'invalid_client' } });

            try {
                await exchangeAuthorizationCode({
                    clientId: 'c',
                    clientSecret: 's',
                    code: 'x',
                    codeVerifier: 'v',
                    redirectUri: 'https://deepnote.com/cb',
                    tokenUrl: stub.url
                });
                assert.fail('expected InvalidClientError');
            } catch (err) {
                assert(err instanceof InvalidClientError);
            }
        });

        test('throws generic Error on missing refresh_token (consent likely revoked)', async () => {
            stub.setBehavior({
                status: 200,
                body: { access_token: 'a', token_type: 'Bearer' }
            });

            try {
                await exchangeAuthorizationCode({
                    clientId: 'c',
                    clientSecret: 's',
                    code: 'x',
                    codeVerifier: 'v',
                    redirectUri: 'https://deepnote.com/cb',
                    tokenUrl: stub.url
                });
                assert.fail('expected rejection');
            } catch (err) {
                assert(err instanceof Error);
                assert.include(err.message, 'No refresh token returned');
                assert.include(err.message, 'my-account.google.com/permissions');
            }
        });

        test('times out a hanging request', async () => {
            // Override the stub server with one that never responds.
            const hangingServer = http.createServer(() => {
                // Drop the connection.
            });
            await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()));
            const hangingAddress = hangingServer.address() as AddressInfo;
            const hangingUrl = `http://127.0.0.1:${hangingAddress.port}/oauth/token`;

            try {
                try {
                    await exchangeAuthorizationCode(
                        {
                            clientId: 'c',
                            clientSecret: 's',
                            code: 'x',
                            codeVerifier: 'v',
                            redirectUri: 'https://deepnote.com/cb',
                            tokenUrl: hangingUrl
                        },
                        50
                    );
                    assert.fail('expected timeout');
                } catch (err) {
                    assert(err instanceof Error);
                }
            } finally {
                await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
            }
        });
    });
});
