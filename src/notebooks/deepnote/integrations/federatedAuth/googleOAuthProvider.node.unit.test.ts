import { assert } from 'chai';

import { GOOGLE_BIGQUERY_SCOPES, createInMemoryPkceStore } from './googleOAuthProvider.node';
import { buildTestStrategy } from './federatedAuthTestHelpers.node';

suite('googleOAuthProvider', () => {
    suite('GOOGLE_BIGQUERY_SCOPES', () => {
        test('exposes email, profile, and the bigquery scope (no openid)', () => {
            // openid is omitted; refresh tokens come from `access_type=offline` + `prompt=consent`.
            assert.deepStrictEqual(
                [...GOOGLE_BIGQUERY_SCOPES],
                ['email', 'profile', 'https://www.googleapis.com/auth/bigquery']
            );
        });
    });

    suite('createInMemoryPkceStore', () => {
        test('store + verify round-trips the code verifier', () => {
            const store = createInMemoryPkceStore();
            const verifier = 'random-verifier-12345';

            let issuedState: string | undefined;
            store.store(undefined, verifier, undefined, undefined, (err, state) => {
                assert.isNull(err);
                assert.isString(state);
                issuedState = state;
            });

            assert.isDefined(issuedState);

            let verifyResult: { ok: string | false; info: unknown } | undefined;
            store.verify(undefined, issuedState!, undefined, (err, ok, info) => {
                assert.isNull(err);
                verifyResult = { ok, info };
            });

            assert.isDefined(verifyResult);
            // PKCE: `ok` must be the codeVerifier string so passport-oauth2 forwards it (strategy.js:171-173).
            assert.strictEqual(verifyResult!.ok, verifier);
        });

        test('store generates a non-empty, URL-safe state', () => {
            const store = createInMemoryPkceStore();
            let issuedState: string | undefined;
            store.store(undefined, 'v', undefined, undefined, (_err, state) => {
                issuedState = state;
            });
            assert.isString(issuedState);
            assert.isAbove(issuedState!.length, 0);
            // base64url alphabet: A-Z, a-z, 0-9, -, _ (no padding).
            assert.match(issuedState!, /^[A-Za-z0-9_-]+$/);
        });

        test('store generates distinct states across calls', () => {
            const store = createInMemoryPkceStore();
            const states: string[] = [];
            for (let i = 0; i < 5; i++) {
                store.store(undefined, `v-${i}`, undefined, undefined, (_err, state) => {
                    states.push(state!);
                });
            }
            assert.strictEqual(new Set(states).size, 5);
        });

        test('verify with unknown state returns (null, false, info)', () => {
            const store = createInMemoryPkceStore();
            let result: { ok: string | false; info: unknown } | undefined;
            store.verify(undefined, 'never-issued', undefined, (err, ok, info) => {
                assert.isNull(err);
                result = { ok, info };
            });
            assert.isDefined(result);
            assert.strictEqual(result!.ok, false);
            assert.isDefined(result!.info);
        });

        test('verify deletes the entry (single-use)', () => {
            const store = createInMemoryPkceStore();
            let issuedState!: string;
            store.store(undefined, 'verifier', undefined, undefined, (_err, state) => {
                issuedState = state!;
            });

            // First verify: succeeds.
            let firstResult: string | false | undefined;
            store.verify(undefined, issuedState, undefined, (_err, ok) => {
                firstResult = ok;
            });
            assert.strictEqual(firstResult, 'verifier');

            // Second verify with the same state: must fail (entry was deleted).
            let secondResult: string | false | undefined;
            store.verify(undefined, issuedState, undefined, (_err, ok) => {
                secondResult = ok;
            });
            assert.strictEqual(secondResult, false);
        });

        test('isolated stores do not share state', () => {
            const a = createInMemoryPkceStore();
            const b = createInMemoryPkceStore();
            let stateA!: string;
            a.store(undefined, 'va', undefined, undefined, (_err, state) => {
                stateA = state!;
            });
            // Verify stateA against the *other* store: must fail.
            let result: string | false | undefined;
            b.verify(undefined, stateA, undefined, (_err, ok) => {
                result = ok;
            });
            assert.strictEqual(result, false);
        });
    });

    suite('buildBigQueryGoogleOAuthStrategy', () => {
        test('strategy.name is "google" (the passport-google-oauth20 default)', () => {
            const { strategy } = buildTestStrategy();
            assert.strictEqual(strategy.name, 'google');
        });

        test('uses the GOOGLE_BIGQUERY_SCOPES on the strategy', () => {
            const { strategy } = buildTestStrategy();
            // `_scope` is set by passport-oauth2 from options.scope; probe to assert wiring.
            const scope = (strategy as unknown as { _scope: string[] })._scope;
            assert.deepStrictEqual(scope, [...GOOGLE_BIGQUERY_SCOPES]);
        });

        test('verify resolves the completion promise on a non-empty refresh token', async () => {
            const { strategy, completion } = buildTestStrategy();

            // `_verify` is stored by passport-oauth2 (strategy.js:~70).
            const verify = (strategy as unknown as { _verify: Function })._verify;

            verify(
                'access-token',
                'refresh-token-value',
                { id: 'user-1', provider: 'google' },
                (_err: unknown, user: unknown) => {
                    assert.deepStrictEqual(user, { refreshToken: 'refresh-token-value' });
                }
            );

            const result = await completion;
            assert.deepStrictEqual(result, { refreshToken: 'refresh-token-value' });
        });

        test('verify rejects the completion promise on an empty refresh token', async () => {
            const { strategy, completion } = buildTestStrategy();

            const verify = (strategy as unknown as { _verify: Function })._verify;
            verify('access-token', '', { id: 'u', provider: 'google' }, () => {
                // done() is called with the error — we ignore here.
            });

            try {
                await completion;
                assert.fail('expected rejection');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.include((err as Error).message, 'No refresh token returned');
                assert.include((err as Error).message, 'myaccount.google.com/permissions');
            }
        });

        function oauth2Urls(strategy: object): { _authorizeUrl: string; _accessTokenUrl: string } {
            return (strategy as unknown as { _oauth2: { _authorizeUrl: string; _accessTokenUrl: string } })._oauth2;
        }

        test('authorizationURL and tokenURL overrides land on the strategy', () => {
            const { strategy } = buildTestStrategy({
                authorizationURL: 'http://stub/oauth/authorize',
                tokenURL: 'http://stub/oauth/token'
            });

            const { _authorizeUrl, _accessTokenUrl } = oauth2Urls(strategy);
            assert.deepStrictEqual(
                { authorizeUrl: _authorizeUrl, accessTokenUrl: _accessTokenUrl },
                { authorizeUrl: 'http://stub/oauth/authorize', accessTokenUrl: 'http://stub/oauth/token' }
            );
        });

        test('without overrides, the strategy uses Google production URLs', () => {
            const { strategy } = buildTestStrategy();

            // passport-google-oauth20/lib/strategy.js:49-50.
            const { _authorizeUrl, _accessTokenUrl } = oauth2Urls(strategy);
            assert.deepStrictEqual(
                { authorizeUrl: _authorizeUrl, accessTokenUrl: _accessTokenUrl },
                {
                    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
                    accessTokenUrl: 'https://www.googleapis.com/oauth2/v4/token'
                }
            );
        });
    });
});
