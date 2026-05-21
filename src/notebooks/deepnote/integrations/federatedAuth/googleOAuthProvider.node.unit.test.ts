import { assert } from 'chai';

import {
    buildBigQueryGoogleOAuthStrategy,
    createInMemoryPkceStore,
    GOOGLE_BIGQUERY_SCOPES,
    GOOGLE_TOKEN_URL
} from './googleOAuthProvider.node';

suite('googleOAuthProvider', () => {
    suite('GOOGLE_BIGQUERY_SCOPES', () => {
        test('exposes email, profile, and the bigquery scope (no openid)', () => {
            assert.deepStrictEqual(
                [...GOOGLE_BIGQUERY_SCOPES],
                ['email', 'profile', 'https://www.googleapis.com/auth/bigquery']
            );
        });

        test('does not include openid', () => {
            // Plan invariant (Step 5): production at
            // /workspace/deepnote-internal/apps/webapp/server/modules/federated-integration-auth/handlers.ts:77
            // omits 'openid'. Refresh tokens come from access_type=offline +
            // prompt=consent, not from the OpenID Connect flow.
            assert.notInclude([...GOOGLE_BIGQUERY_SCOPES], 'openid');
        });
    });

    suite('GOOGLE_TOKEN_URL', () => {
        test('points at the production Google token endpoint', () => {
            assert.strictEqual(GOOGLE_TOKEN_URL, 'https://oauth2.googleapis.com/token');
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
            // For PKCE, the `ok` slot must hold the codeVerifier string so
            // passport-oauth2 forwards it as `code_verifier` on the token
            // request (see strategy.js:171-173).
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

        test('store and verify both accept undefined req (no req.session needed)', () => {
            // Plan invariant (Step 5): the custom store must work without
            // express-session. We pass undefined for req and assert no throw.
            const store = createInMemoryPkceStore();
            let issuedState!: string;
            assert.doesNotThrow(() => {
                store.store(undefined, 'v', undefined, undefined, (_err, state) => {
                    issuedState = state!;
                });
            });
            assert.doesNotThrow(() => {
                store.verify(undefined, issuedState, undefined, () => {
                    // no-op
                });
            });
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
        test('returns a strategy and a completion promise', () => {
            const store = createInMemoryPkceStore();
            const result = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store
            });

            assert.isObject(result.strategy);
            assert.instanceOf(result.completion, Promise);
        });

        test('strategy.name is "google" (the passport-google-oauth20 default)', () => {
            const store = createInMemoryPkceStore();
            const result = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store
            });

            assert.strictEqual(result.strategy.name, 'google');
        });

        test('uses the GOOGLE_BIGQUERY_SCOPES on the strategy', () => {
            const store = createInMemoryPkceStore();
            const result = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store
            });

            // `_scope` is a protected field on OAuth2Strategy; passport-oauth2
            // sets it from options.scope. We probe it to assert wiring.
            const scope = (result.strategy as unknown as { _scope: string[] })._scope;
            assert.deepStrictEqual(scope, [...GOOGLE_BIGQUERY_SCOPES]);
        });

        test('verify resolves the completion promise on a non-empty refresh token', async () => {
            const store = createInMemoryPkceStore();
            const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store
            });

            // `_verify` is the verify callback stored by passport-oauth2 (see
            // passport-oauth2/lib/strategy.js around line 70).
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
            const store = createInMemoryPkceStore();
            const { strategy, completion } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store
            });

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

        test('authorizationURL override lands on the strategy', () => {
            const store = createInMemoryPkceStore();
            const { strategy } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store,
                authorizationURL: 'http://stub/oauth/authorize'
            });

            // passport-oauth2 stores the URL on the embedded `_oauth2` helper.
            const oauth2 = (strategy as unknown as { _oauth2: { _authorizeUrl: string } })._oauth2;
            assert.strictEqual(oauth2._authorizeUrl, 'http://stub/oauth/authorize');
        });

        test('tokenURL override lands on the strategy', () => {
            const store = createInMemoryPkceStore();
            const { strategy } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store,
                tokenURL: 'http://stub/oauth/token'
            });

            const oauth2 = (strategy as unknown as { _oauth2: { _accessTokenUrl: string } })._oauth2;
            assert.strictEqual(oauth2._accessTokenUrl, 'http://stub/oauth/token');
        });

        test('without overrides, the strategy uses Google production URLs', () => {
            const store = createInMemoryPkceStore();
            const { strategy } = buildBigQueryGoogleOAuthStrategy({
                clientId: 'cid',
                clientSecret: 'cs',
                store
            });

            const oauth2 = (
                strategy as unknown as {
                    _oauth2: { _authorizeUrl: string; _accessTokenUrl: string };
                }
            )._oauth2;
            // passport-google-oauth20/lib/strategy.js:49-50.
            assert.strictEqual(oauth2._authorizeUrl, 'https://accounts.google.com/o/oauth2/v2/auth');
            assert.strictEqual(oauth2._accessTokenUrl, 'https://www.googleapis.com/oauth2/v4/token');
        });
    });
});
