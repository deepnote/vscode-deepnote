import * as crypto from 'crypto';
import { Profile as GoogleProfile, Strategy as GoogleStrategy, VerifyCallback } from 'passport-google-oauth20';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** OAuth scopes for BigQuery federated auth. Mirrors handlers.ts:77; `openid` omitted (refresh tokens come from `access_type=offline` + `prompt=consent`). */
export const GOOGLE_BIGQUERY_SCOPES = ['email', 'profile', 'https://www.googleapis.com/auth/bigquery'] as const;

/** Per-flow record in an {@link InMemoryPkceStore}; `meta` is opaque to us and just round-tripped for passport-oauth2. */
interface PkceRecord {
    codeVerifier: string;
    meta: unknown;
}

/**
 * passport-oauth2 state-store with 5-arg `store` / 4-arg `verify` shapes so its arity check picks the PKCE
 * branch (strategy.js:218-298). The verify `ok` slot must hold the codeVerifier string (strategy.js:171-173).
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

/** Per-flow PKCE/state store: substitutes for passport-oauth2's built-in `PKCESessionStore` (which requires `req.session`). Each call gets its own store to isolate concurrent flows. */
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
            // PKCE: `ok` must be the codeVerifier string (strategy.js:171-173).
            cb(null, record.codeVerifier);
        }
    };
}

/** Result of {@link buildBigQueryGoogleOAuthStrategy}: configured passport strategy + completion promise (resolves with the captured refresh token; rejects on empty). */
export interface BigQueryGoogleOAuthStrategy {
    completion: Promise<{ refreshToken: string }>;
    strategy: GoogleStrategy;
}

/** Params for {@link buildBigQueryGoogleOAuthStrategy}; `authorizationURL`/`tokenURL` are test seams (defaults to Google's bundled URLs per passport-google-oauth20/strategy.js:49-50). */
export interface BuildBigQueryGoogleOAuthStrategyParams {
    authorizationURL?: string;
    clientId: string;
    clientSecret: string;
    store: InMemoryPkceStore;
    tokenURL?: string;
}

/** Builds Google OAuth strategy + verify pair. Verify resolves `completion` on a non-empty refresh token; an empty token rejects with the "Revoke the app at myaccount.google.com/permissions" guidance. */
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
        // Placeholder; overwritten by runOAuthFlow once a port is bound.
        callbackURL: 'http://127.0.0.1:0/auth/callback',
        scope: [...GOOGLE_BIGQUERY_SCOPES],
        pkce: true,
        state: true,
        // We only want the refresh token; skip the userinfo fetch (would fail with stub access tokens in tests).
        skipUserProfile: true,
        // Cast: @types/passport-oauth2 lacks the PKCE 5/4-arg overloads (index.d.ts:37-43) but passport-oauth2 picks them via `Function.length` (strategy.js:218-298).
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
        // Truthy `user` so passport renders the configured /auth/callback success response.
        done(null, { refreshToken } as unknown as Express.User);
    };

    const strategy = new GoogleStrategy(strategyOptions, verify);

    return { strategy, completion };
}

export { GoogleStrategy };
