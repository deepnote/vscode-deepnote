import * as crypto from 'crypto';
import { z } from 'zod';

import { InvalidClientError, InvalidGrantError } from './federatedAuthTokenStorage.node';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** OAuth scopes for BigQuery federated auth. Mirrors deepnote-internal handlers.ts:77; `openid` omitted (refresh tokens come from `access_type=offline` + `prompt=consent`). */
export const GOOGLE_BIGQUERY_SCOPES = ['email', 'profile', 'https://www.googleapis.com/auth/bigquery'] as const;

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

const tokenEndpointErrorResponseSchema = z.object({
    error: z.string(),
    error_description: z.string().optional()
});

const tokenEndpointSuccessResponseSchema = z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional()
});

const tokenEndpointResponseSchema = z.union([tokenEndpointSuccessResponseSchema, tokenEndpointErrorResponseSchema]);

/** PKCE S256 pair. Verifier is 32 random bytes encoded as base64url (Google requires 43-128 chars; 32 bytes → 43). */
export function generatePkcePair(): { challenge: string; verifier: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    return { challenge, verifier };
}

/** Random base64url nonce for the CSRF `state` parameter; 24 bytes → 32 chars. */
export function generateOAuthStateNonce(): string {
    return crypto.randomBytes(24).toString('base64url');
}

/** Inputs for {@link exchangeAuthorizationCode}; `tokenUrl` is a test seam (defaults to {@link GOOGLE_TOKEN_URL}). `redirectUri` must match the one used in the original `/authorize` request — Google rejects the exchange otherwise. */
export interface ExchangeAuthorizationCodeParams {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    tokenUrl?: string;
}

/**
 * POSTs `grant_type=authorization_code` to Google's token endpoint and returns the refresh + access
 * tokens. Mirrors {@link fetchFreshAccessToken}'s HTTP shape (Basic auth, urlencoded body, zod-validated
 * response) and reuses {@link InvalidGrantError} / {@link InvalidClientError} for the same error taxonomy.
 * Throws if Google's response omits `refresh_token` (we always set `prompt=consent` upstream, so a missing
 * refresh token here means the user revoked offline access between authorize and callback).
 */
export async function exchangeAuthorizationCode(
    params: ExchangeAuthorizationCodeParams,
    timeoutMs: number = TOKEN_EXCHANGE_TIMEOUT_MS
): Promise<{ accessToken: string; refreshToken: string }> {
    const tokenUrl = params.tokenUrl ?? GOOGLE_TOKEN_URL;
    const basicAuth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier
    }).toString();

    let response: Response | undefined;
    let rawBody: unknown;
    try {
        response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body,
            signal: controller.signal
        });
        rawBody = await response.json();
    } catch (error) {
        if (error instanceof SyntaxError && response !== undefined) {
            throw new Error(
                `Token exchange response was not valid JSON (HTTP ${response.status} ${response.statusText}).`,
                { cause: error }
            );
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    const parsed = tokenEndpointResponseSchema.safeParse(rawBody);
    if (!parsed.success) {
        throw new Error(`Token exchange returned invalid response body: ${parsed.error.message}`);
    }
    const data = parsed.data;

    if (!response.ok) {
        if (!('error' in data)) {
            throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
        }
        if (data.error === 'invalid_grant') {
            throw new InvalidGrantError(data.error_description ?? 'Authorization code rejected by OAuth provider.');
        }
        if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
            throw new InvalidClientError(data.error_description ?? 'OAuth client credentials rejected by provider.');
        }
        throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
    }

    if ('error' in data) {
        throw new Error('Token exchange succeeded but response body contained an OAuth error.');
    }
    if (!data.refresh_token) {
        throw new Error(
            'No refresh token returned. Revoke the app at my-account.google.com/permissions and try again.'
        );
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token
    };
}
