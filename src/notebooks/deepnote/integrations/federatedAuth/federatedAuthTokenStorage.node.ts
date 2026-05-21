import { createHash } from 'crypto';
import { inject, injectable } from 'inversify';
import { EventEmitter } from 'vscode';
import { z } from 'zod';

import { IEncryptedStorage } from '../../../../platform/common/application/types';
import { IAsyncDisposableRegistry } from '../../../../platform/common/types';
import { logger } from '../../../../platform/logging';
import { FederatedAuthTokenEntry, IFederatedAuthTokenStorage } from '../types';

const FEDERATED_AUTH_TOKEN_SERVICE_NAME = 'deepnote-federated-auth-tokens';
const INDEX_KEY = 'index';
const TOKEN_REFRESH_TIMEOUT_MS = 15_000; // 15s

/**
 * Schema for the body returned by Google's OAuth token endpoint when
 * exchanging a refresh token for a fresh access token.
 *
 * The shape mirrors the production response handling at
 * /workspace/deepnote-internal/libs/shared-node/src/integration-federated-auth/integration-federated-auth.ts:372-433.
 *
 * - `access_token`: required on 2xx responses.
 * - `refresh_token`: returned only when Google rotates the refresh token.
 * - `expires_in`: seconds until the access token expires (unused — we never cache).
 * - `error`: returned on non-2xx responses (e.g. 'invalid_grant', 'invalid_client').
 */
const tokenEndpointResponseSchema = z.object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    error: z.string().optional(),
    error_description: z.string().optional()
});

/**
 * Thrown when the OAuth provider rejects the refresh request with
 * `error: 'invalid_grant'`. Indicates the stored refresh token is no
 * longer usable (revoked, expired, or invalidated by the user).
 *
 * Callers typically respond by deleting the stored token entry and
 * surfacing a "Not authenticated" state to the user.
 */
export class InvalidGrantError extends Error {
    constructor(message = 'Refresh token rejected by OAuth provider.') {
        super(message);
        this.name = 'InvalidGrantError';
    }
}

/**
 * Thrown when the OAuth provider rejects the refresh request with
 * `error: 'invalid_client'` or `error: 'unauthorized_client'`. Indicates
 * the OAuth client metadata stored on the integration is misconfigured
 * (e.g. wrong clientId/clientSecret).
 */
export class InvalidClientError extends Error {
    constructor(message = 'OAuth client credentials rejected by provider.') {
        super(message);
        this.name = 'InvalidClientError';
    }
}

/**
 * Computes a SHA-256 fingerprint of the OAuth-client metadata on a federated
 * integration. The fingerprint is `${clientId}|${clientSecret}|${project}`
 * hashed with SHA-256.
 *
 * Used to detect when the user edits OAuth client metadata after a token
 * has been saved — the stored entry's `metadataFingerprint` no longer
 * matches the integration, so the token must be invalidated before use.
 */
export function computeMetadataFingerprint(metadata: {
    clientId: string;
    clientSecret: string;
    project: string;
}): string {
    return createHash('sha256')
        .update(`${metadata.clientId}|${metadata.clientSecret}|${metadata.project}`)
        .digest('hex');
}

/**
 * POSTs a `grant_type=refresh_token` request to the OAuth token endpoint
 * and returns the resulting fresh access token. Optionally returns a
 * rotated refresh token if the provider issues one — callers are
 * responsible for persisting it via `IFederatedAuthTokenStorage.save`.
 *
 * The plan's non-negotiable: access tokens are never cached, neither at
 * rest nor in memory beyond the single execution preparation that needs
 * them. This function MUST be called before every SQL cell execution.
 *
 * `timeoutMs` overrides {@link TOKEN_REFRESH_TIMEOUT_MS}. It exists as a
 * test seam so the timeout-on-slow-body scenario can be exercised without
 * sleeping for 15 seconds; production callers should leave it undefined.
 *
 * Reference implementation:
 * /workspace/deepnote-internal/libs/shared-node/src/integration-federated-auth/integration-federated-auth.ts:350-434
 */
export async function fetchFreshAccessToken(
    entry: FederatedAuthTokenEntry,
    oauthConfig: { tokenUrl: string; clientId: string; clientSecret: string },
    timeoutMs: number = TOKEN_REFRESH_TIMEOUT_MS
): Promise<{ accessToken: string; newRefreshToken?: string }> {
    const basicAuth = Buffer.from(`${oauthConfig.clientId}:${oauthConfig.clientSecret}`).toString('base64');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // The same AbortController governs both the initial fetch and the
    // body-read (`response.json()`) so a slow body stream is also bounded
    // by the timeout — Google sometimes sends headers fast and the body
    // slow. The single `finally` ensures the timer is cleared regardless
    // of which step fails.
    let response: Response | undefined;
    let rawBody: unknown;
    try {
        response = await fetch(oauthConfig.tokenUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(entry.refreshToken)}`,
            signal: controller.signal
        });
        rawBody = await response.json();
    } catch (error) {
        if (error instanceof SyntaxError && response !== undefined) {
            throw new Error(
                `Token refresh response was not valid JSON (HTTP ${response.status} ${response.statusText}).`,
                { cause: error }
            );
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    const parsed = tokenEndpointResponseSchema.safeParse(rawBody);
    if (!parsed.success) {
        throw new Error(`Token refresh returned invalid response body: ${parsed.error.message}`);
    }

    const data = parsed.data;

    if (!response.ok) {
        if (data.error === 'invalid_grant') {
            throw new InvalidGrantError();
        }
        if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
            throw new InvalidClientError();
        }
        throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
    }

    if (!data.access_token) {
        throw new Error('Token refresh succeeded but response did not include an access_token.');
    }

    return {
        accessToken: data.access_token,
        newRefreshToken: data.refresh_token ?? undefined
    };
}

/**
 * Encrypted-storage backed implementation of {@link IFederatedAuthTokenStorage}.
 *
 * Mirrors the cache+index pattern in {@link IntegrationStorage}:
 *   - Each entry is stored under its `integrationId` key.
 *   - A separate `'index'` key holds a JSON array of known IDs so the
 *     cache can be hydrated lazily on first access.
 *   - An in-memory cache keeps reads cheap once hydrated.
 *
 * Plan non-negotiable: only the long-lived `refreshToken` (plus the
 * integration id and metadata fingerprint) is persisted. Access tokens
 * are never written here — they're fetched on demand for each cell
 * execution via {@link fetchFreshAccessToken}.
 */
@injectable()
export class FederatedAuthTokenStorage implements IFederatedAuthTokenStorage {
    private readonly cache: Map<string, FederatedAuthTokenEntry> = new Map();

    private cacheLoaded = false;

    private readonly _onDidChangeTokens = new EventEmitter<string>();

    public readonly onDidChangeTokens = this._onDidChangeTokens.event;

    constructor(
        @inject(IEncryptedStorage) private readonly encryptedStorage: IEncryptedStorage,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry
    ) {
        // Register for disposal when the extension deactivates.
        asyncRegistry.push(this);
    }

    public async delete(integrationId: string): Promise<void> {
        await this.ensureCacheLoaded();

        if (!this.cache.has(integrationId)) {
            return;
        }

        await this.encryptedStorage.store(FEDERATED_AUTH_TOKEN_SERVICE_NAME, integrationId, undefined);
        this.cache.delete(integrationId);
        await this.updateIndex();

        this._onDidChangeTokens.fire(integrationId);
    }

    public dispose(): void {
        this._onDidChangeTokens.dispose();
    }

    public async get(integrationId: string): Promise<FederatedAuthTokenEntry | undefined> {
        await this.ensureCacheLoaded();
        return this.cache.get(integrationId);
    }

    public async has(integrationId: string): Promise<boolean> {
        await this.ensureCacheLoaded();
        return this.cache.has(integrationId);
    }

    public async save(entry: FederatedAuthTokenEntry): Promise<void> {
        await this.ensureCacheLoaded();

        await this.encryptedStorage.store(
            FEDERATED_AUTH_TOKEN_SERVICE_NAME,
            entry.integrationId,
            JSON.stringify(entry)
        );
        this.cache.set(entry.integrationId, entry);
        await this.updateIndex();

        this._onDidChangeTokens.fire(entry.integrationId);
    }

    /**
     * Hydrate the in-memory cache from encrypted storage. Reads the
     * `'index'` secret first to discover which integration IDs have
     * entries persisted; then loads each entry by id.
     *
     * Tolerates corrupted entries (logs + skips) and a missing/corrupted
     * index (treats storage as empty).
     */
    private async ensureCacheLoaded(): Promise<void> {
        if (this.cacheLoaded) {
            return;
        }

        const indexJson = await this.encryptedStorage.retrieve(FEDERATED_AUTH_TOKEN_SERVICE_NAME, INDEX_KEY);
        if (!indexJson) {
            this.cacheLoaded = true;
            return;
        }

        let integrationIds: string[];
        try {
            const parsed: unknown = JSON.parse(indexJson);
            if (!Array.isArray(parsed)) {
                throw new Error('Index is not an array.');
            }
            integrationIds = parsed.filter((id): id is string => typeof id === 'string');
        } catch (error) {
            logger.error('FederatedAuthTokenStorage: Failed to parse index, treating storage as empty.', error);
            this.cacheLoaded = true;
            return;
        }

        // Mirrors the cleanup pattern in IntegrationStorage:165-241 — collect
        // ids whose entries are unreadable or malformed, then purge them from
        // encrypted storage and rewrite the index after the loop. Without this
        // step, an orphaned refresh-token secret could linger in SecretStorage
        // forever (and in the index until the next save/delete rewrites it).
        const malformedIds: string[] = [];
        for (const id of integrationIds) {
            try {
                const entryJson = await this.encryptedStorage.retrieve(FEDERATED_AUTH_TOKEN_SERVICE_NAME, id);
                if (!entryJson) {
                    continue;
                }
                const parsed = JSON.parse(entryJson) as Partial<FederatedAuthTokenEntry>;
                if (
                    typeof parsed.integrationId === 'string' &&
                    typeof parsed.refreshToken === 'string' &&
                    typeof parsed.metadataFingerprint === 'string'
                ) {
                    this.cache.set(id, {
                        integrationId: parsed.integrationId,
                        refreshToken: parsed.refreshToken,
                        metadataFingerprint: parsed.metadataFingerprint
                    });
                } else {
                    logger.warn(`FederatedAuthTokenStorage: Skipping malformed token entry for ${id}.`);
                    malformedIds.push(id);
                }
            } catch (error) {
                logger.error(`FederatedAuthTokenStorage: Failed to load token entry for ${id}.`, error);
                malformedIds.push(id);
            }
        }

        if (malformedIds.length > 0) {
            logger.info(
                `FederatedAuthTokenStorage: Removing ${malformedIds.length} malformed token entry/entries from storage.`
            );
            for (const id of malformedIds) {
                try {
                    await this.encryptedStorage.store(FEDERATED_AUTH_TOKEN_SERVICE_NAME, id, undefined);
                } catch (error) {
                    logger.error(`FederatedAuthTokenStorage: Failed to delete malformed token entry for ${id}.`, error);
                }
            }
            await this.updateIndex();
        }

        this.cacheLoaded = true;
    }

    private async updateIndex(): Promise<void> {
        const integrationIds = Array.from(this.cache.keys());
        await this.encryptedStorage.store(FEDERATED_AUTH_TOKEN_SERVICE_NAME, INDEX_KEY, JSON.stringify(integrationIds));
    }
}
