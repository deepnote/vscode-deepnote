import * as crypto from 'crypto';
import { Profile as GoogleProfile, Strategy as GoogleStrategy, VerifyCallback } from 'passport-google-oauth20';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * OAuth scopes for BigQuery federated authentication. Mirrors production at
 * /workspace/deepnote-internal/apps/webapp/server/modules/federated-integration-auth/handlers.ts:77.
 *
 * Notably absent: `openid`. Refresh tokens are issued by combining
 * `access_type=offline` + `prompt=consent` on the authorize request — no
 * `openid` scope needed. Adding `openid` triggers ID-token issuance which
 * we don't need.
 */
export const GOOGLE_BIGQUERY_SCOPES = ['email', 'profile', 'https://www.googleapis.com/auth/bigquery'] as const;

/**
 * Shape of the per-flow record kept inside an {@link InMemoryPkceStore}. The
 * `meta` field is opaque to us — passport-oauth2 supplies an object with the
 * `authorizationURL` / `tokenURL` / `clientID` / `callbackURL` keys at call
 * time but we round-trip it without inspection.
 */
interface PkceRecord {
    codeVerifier: string;
    meta: unknown;
}

/**
 * Subset of `passport-oauth2`'s state-store interface that we actually use.
 *
 * passport-oauth2 inspects the function's arity (`store.length` /
 * `verify.length`) to pick between PKCE and non-PKCE call patterns
 * (see `node_modules/passport-oauth2/lib/strategy.js:218-298`). We declare
 * the 5-arg / 4-arg overloads explicitly so we land in the PKCE branch:
 *
 *   - `store(req, verifier, state, meta, cb)` — arity 5, PKCE+state path.
 *   - `verify(req, providedState, meta, cb)` — arity 4, PKCE+state path.
 *
 * The verify callback shape is `(err, ok, state)` per passport-oauth2's
 * `loaded(err, ok, state)` function at strategy.js:160. When PKCE is on,
 * the `ok` slot must hold the `codeVerifier` string (truthy + typeof
 * 'string' triggers the `params.code_verifier = ok` branch at
 * strategy.js:171-173). The `state` slot is the (optional) opaque state
 * value passed to the user code via the success info object.
 */
export interface InMemoryPkceStore {
    store(
        req: unknown,
        verifier: string,
        state: unknown,
        meta: unknown,
        cb: (err: Error | null, state?: string) => void
    ): void;
    verify(
        req: unknown,
        providedState: string,
        meta: unknown,
        cb: (err: Error | null, ok: string | false, info?: unknown) => void
    ): void;
}

/**
 * Builds a per-flow in-memory PKCE/state store compatible with
 * `passport-oauth2`'s state-store contract.
 *
 * Why a custom store: `passport-oauth2`'s built-in `PKCESessionStore`
 * (auto-selected when `pkce: true, state: true` and no `store` option is
 * provided — see `passport-oauth2/lib/strategy.js:105-114`) reads/writes
 * `req.session` and errors when it's undefined. The loopback OAuth flow
 * (Step 5 of the plan) has no `express-session` and adding one is
 * overkill, so we substitute a simple `Map<state, codeVerifier>` keyed
 * by a cryptographically-random state value generated here.
 *
 * Each call to {@link buildBigQueryGoogleOAuthStrategy} should be paired
 * with its own store so concurrent flows don't trample each other.
 */
export function createInMemoryPkceStore(): InMemoryPkceStore {
    const records = new Map<string, PkceRecord>();
    return {
        store(_req, verifier, _state, meta, cb) {
            const state = crypto.randomBytes(24).toString('base64url');
            records.set(state, { codeVerifier: verifier, meta });
            cb(null, state);
        },
        verify(_req, providedState, _meta, cb) {
            const record = records.get(providedState);
            if (record === undefined) {
                cb(null, false, { message: 'Invalid authorization request state.' });
                return;
            }
            records.delete(providedState);
            // passport-oauth2 PKCE: the `ok` slot must hold the codeVerifier
            // string (truthy + typeof 'string' triggers the
            // `params.code_verifier = ok` branch at strategy.js:171-173).
            cb(null, record.codeVerifier);
        }
    };
}

/**
 * Result of {@link buildBigQueryGoogleOAuthStrategy}.
 *
 * - `strategy`: the configured passport strategy. Caller passes this to
 *   `passport.use(name, strategy)` and mounts the standard
 *   `passport.authenticate(name, ...)` middleware on the loopback server.
 * - `completion`: resolves with the captured refresh token once the
 *   verify callback fires, or rejects on a missing/empty refresh token.
 *   The verify closure is set up inside this builder so the call site
 *   cannot forget to wire it.
 */
export interface BigQueryGoogleOAuthStrategy {
    completion: Promise<{ refreshToken: string }>;
    strategy: GoogleStrategy;
}

/**
 * Parameters for {@link buildBigQueryGoogleOAuthStrategy}.
 *
 * `authorizationURL` / `tokenURL` are documented overrides on
 * `passport-google-oauth20`'s strategy options (see
 * `node_modules/passport-google-oauth20/lib/strategy.js:49-50`). When
 * unset, the strategy defaults to Google's bundled URLs. We expose the
 * overrides primarily as test seams — Step 6's plan calls these out
 * explicitly for the runOAuthFlow integration test.
 */
export interface BuildBigQueryGoogleOAuthStrategyParams {
    authorizationURL?: string;
    clientId: string;
    clientSecret: string;
    store: InMemoryPkceStore;
    tokenURL?: string;
}

/**
 * Builds the Google OAuth 2.0 strategy + verify callback pair used by
 * the loopback flow in Step 5. The verify is constructed internally so
 * the call site cannot forget to supply one (production review finding
 * #6 in the plan).
 *
 * The verify resolves the returned `completion` promise on a non-empty
 * refresh token; on an empty refresh token (Google sometimes omits one
 * when the same OAuth client has already been authorized for the same
 * user without an intervening revoke), it rejects with the documented
 * "Revoke the app at myaccount.google.com/permissions and try again."
 * message so the user knows the fix.
 */
export function buildBigQueryGoogleOAuthStrategy(
    params: BuildBigQueryGoogleOAuthStrategyParams
): BigQueryGoogleOAuthStrategy {
    let resolveCompletion!: (value: { refreshToken: string }) => void;
    let rejectCompletion!: (reason: Error) => void;
    const completion = new Promise<{ refreshToken: string }>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });

    const strategyOptions = {
        clientID: params.clientId,
        clientSecret: params.clientSecret,
        // Overwritten by runOAuthFlow once the loopback server has bound a port.
        // We start with a placeholder so the strategy options pass validation.
        callbackURL: 'http://127.0.0.1:0/auth/callback',
        scope: [...GOOGLE_BIGQUERY_SCOPES],
        pkce: true,
        state: true,
        // Skip the user-profile fetch. passport-oauth2 calls
        // strategy.userProfile(accessToken, done) after the token exchange,
        // which in passport-google-oauth20 hits
        // https://www.googleapis.com/oauth2/v3/userinfo. We don't need the
        // profile — we only care about capturing the refresh token — and
        // hitting the real userinfo endpoint with a stub access token would
        // fail with "Invalid Credentials".
        skipUserProfile: true,
        // @types/passport-oauth2's `StateStore` interface only declares the
        // non-PKCE 2-/3-arg `store` and 3-arg `verify` overloads (see
        // node_modules/@types/passport-oauth2/index.d.ts:37-43). Our
        // PKCE-flavored store uses the 5-arg `store` and 4-arg `verify`
        // shapes that passport-oauth2 selects at runtime via
        // `Function.length` inspection (see
        // node_modules/passport-oauth2/lib/strategy.js:218-298). There is no
        // strict-typed path until DefinitelyTyped adds the PKCE overloads;
        // the cast preserves runtime correctness and is intentionally
        // narrowed to this single field so the rest of the options remain
        // strictly typed.
        store: params.store as never,
        passReqToCallback: false as const,
        ...(params.authorizationURL ? { authorizationURL: params.authorizationURL } : {}),
        ...(params.tokenURL ? { tokenURL: params.tokenURL } : {})
    };

    const verify = (
        _accessToken: string,
        refreshToken: string,
        _profile: GoogleProfile,
        done: VerifyCallback
    ): void => {
        if (!refreshToken) {
            const err = new Error(
                'No refresh token returned. Revoke the app at myaccount.google.com/permissions and try again.'
            );
            rejectCompletion(err);
            done(err);
            return;
        }
        resolveCompletion({ refreshToken });
        // Pass a truthy `user` so passport considers the authentication
        // successful and renders the configured /auth/callback response.
        done(null, { refreshToken } as unknown as Express.User);
    };

    const strategy = new GoogleStrategy(strategyOptions, verify);

    return { strategy, completion };
}

export { GoogleStrategy };
