import type { DeepnoteBlock } from '@deepnote/blocks';
import { Event } from 'vscode';

import { IntegrationWithStatus } from '../../../platform/notebooks/deepnote/integrationTypes';

// Re-export IIntegrationStorage from platform layer
export { IIntegrationStorage } from '../../../platform/notebooks/deepnote/types';

export const IIntegrationDetector = Symbol('IIntegrationDetector');
export interface IIntegrationDetector {
    /**
     * Detect all integrations used in the given project
     */
    detectIntegrations(projectId: string): Promise<Map<string, IntegrationWithStatus>>;

    /**
     * Check if a project has any unconfigured integrations
     */
    hasUnconfiguredIntegrations(projectId: string): Promise<boolean>;
}

export const IIntegrationWebviewProvider = Symbol('IIntegrationWebviewProvider');
export interface IIntegrationWebviewProvider {
    /**
     * Show the integration management webview
     * @param projectId The Deepnote project ID
     * @param integrations Map of integration IDs to their status
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     */
    show(
        projectId: string,
        integrations: Map<string, IntegrationWithStatus>,
        selectedIntegrationId?: string
    ): Promise<void>;
}

export const IIntegrationManager = Symbol('IIntegrationManager');
export interface IIntegrationManager {
    /**
     * Activate the integration manager by registering commands and event listeners
     */
    activate(): void;
}

/**
 * A persisted federated-auth token entry for a single integration.
 *
 * The fingerprint is computed from `${clientId}|${clientSecret}|${project}`
 * so we can detect stale tokens after the user edits their OAuth client
 * metadata and invalidate them without consulting Google.
 *
 * Access tokens are never persisted — only the long-lived refresh token.
 */
export interface FederatedAuthTokenEntry {
    integrationId: string;
    refreshToken: string;
    metadataFingerprint: string;
}

/**
 * Shape of the OAuth-client metadata fingerprinted by
 * {@link IFederatedAuthTokenStorage.computeMetadataFingerprint}. Mirrors
 * the `google-oauth` branch of the BigQuery integration metadata schema in
 * `@deepnote/database-integrations`.
 */
export interface FederatedAuthFingerprintInput {
    clientId: string;
    clientSecret: string;
    project: string;
}

export const IFederatedAuthTokenStorage = Symbol('IFederatedAuthTokenStorage');
export interface IFederatedAuthTokenStorage {
    /**
     * Fires when a token is saved or deleted; the payload is the integration id.
     */
    readonly onDidChangeTokens: Event<string>;
    /**
     * Computes the canonical fingerprint of the OAuth-client metadata on a
     * federated BigQuery integration. Exposed on the interface (rather than
     * imported directly from `federatedAuthTokenStorage.node`) so callers
     * bound on both node and web — notably `IntegrationWebviewProvider` —
     * don't have to import the node-only implementation file.
     */
    computeMetadataFingerprint(metadata: FederatedAuthFingerprintInput): string;
    delete(integrationId: string): Promise<void>;
    get(integrationId: string): Promise<FederatedAuthTokenEntry | undefined>;
    has(integrationId: string): Promise<boolean>;
    /**
     * Lists all integration IDs that currently have a stored refresh-token
     * entry. Exposed for orphaned-token cleanup — callers compare this list
     * against the active set of integrations and delete any tokens whose
     * integration no longer exists.
     */
    listIntegrationIds(): Promise<string[]>;
    /**
     * Persists a token entry.
     *
     * By default, fires `onDidChangeTokens` so listeners (e.g., the kernel
     * restart bridge, the integration webview) can react to authentication
     * state changes. Pass `options.silent = true` for refresh-token
     * rotation: the rotated value is functionally equivalent — the
     * extension mints a fresh access token via the per-cell pre-execute on
     * every SQL block run, so a rotation event has no actionable effect on
     * a running kernel and would only interrupt an in-flight SQL cell.
     */
    save(entry: FederatedAuthTokenEntry, options?: { silent?: boolean }): Promise<void>;
}

export const IFederatedAuthSqlBlockCodeGenerator = Symbol('IFederatedAuthSqlBlockCodeGenerator');
export interface IFederatedAuthSqlBlockCodeGenerator {
    /**
     * For a federated BigQuery SQL block, returns:
     *   - prelude: Python to run via a silent pre-execute (variable
     *     definition with the fresh access token). Never runs through
     *     the normal cell-history path.
     *   - cellCode: Python to run as the cell's main execute. References
     *     the variable defined by prelude. Safe to put in In[] history.
     *
     * Returns undefined for any block that is not a federated BigQuery
     * SQL cell, so callers fall back to @deepnote/blocks.createPythonCode.
     */
    generate(block: DeepnoteBlock): Promise<{ prelude: string; cellCode: string } | undefined>;
}

/**
 * Thrown by `IFederatedAuthSqlBlockCodeGenerator.generate` (and related
 * call sites) when the integration is federated but has no usable refresh
 * token — either because the user has not authenticated yet or because the
 * stored token was invalidated (fingerprint mismatch, `invalid_grant`).
 */
export class NotAuthenticatedError extends Error {
    constructor(public readonly integrationName: string) {
        super(`Integration "${integrationName}" is not authenticated.`);
        this.name = 'NotAuthenticatedError';
    }
}

/**
 * Thrown by `IFederatedAuthSqlBlockCodeGenerator.generate` when the OAuth
 * provider rejects the refresh request with `invalid_client` or
 * `unauthorized_client` — i.e. the integration's stored OAuth client
 * metadata (clientId/clientSecret) is misconfigured.
 *
 * Distinct from {@link NotAuthenticatedError}: re-running the OAuth flow
 * won't fix the issue; the user must correct the client credentials in
 * the integration settings.
 *
 * Lives in cross-platform `types.ts` (alongside `NotAuthenticatedError`)
 * so the cell-execution path — which is bound on both node and web — can
 * `instanceof`-check against it without importing the node-only
 * `InvalidClientError` from `federatedAuthTokenStorage.node`.
 */
export class OAuthClientMisconfiguredError extends Error {
    constructor(public readonly integrationName: string) {
        super(`OAuth client for integration "${integrationName}" is misconfigured.`);
        this.name = 'OAuthClientMisconfiguredError';
    }
}
