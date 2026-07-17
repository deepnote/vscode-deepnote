import type { DeepnoteBlock } from '@deepnote/blocks';
import { Event, NotebookDocument, Uri } from 'vscode';

import { IntegrationWithStatus } from '../../../platform/notebooks/deepnote/integrationTypes';

// Re-export IIntegrationStorage from platform layer
export { IIntegrationStorage } from '../../../platform/notebooks/deepnote/types';

export const IIntegrationDetector = Symbol('IIntegrationDetector');
export interface IIntegrationDetector {
    /**
     * Detect all integrations used in the given project
     */
    detectIntegrations(projectId: string, notebookId: string): Promise<Map<string, IntegrationWithStatus>>;

    /**
     * Check if a project has any unconfigured integrations
     */
    hasUnconfiguredIntegrations(projectId: string, notebookId: string): Promise<boolean>;
}

export const IIntegrationWebviewProvider = Symbol('IIntegrationWebviewProvider');
export interface IIntegrationWebviewProvider {
    /**
     * Show the integration management webview
     * @param projectId The Deepnote project ID
     * @param integrations Map of integration IDs to their status
     * @param activeFileUri The `.deepnote` file being edited — always persisted to disk on save
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     * @param projectName Optional project display name (sourced from the active notebook's metadata)
     */
    show(
        projectId: string,
        integrations: Map<string, IntegrationWithStatus>,
        activeFileUri: Uri,
        selectedIntegrationId?: string,
        projectName?: string
    ): Promise<void>;
}

export const IIntegrationManager = Symbol('IIntegrationManager');
export interface IIntegrationManager {
    /**
     * Activate the integration manager by registering commands and event listeners
     */
    activate(): void;
}

export const IIntegrationEnvLiveRefresher = Symbol('IIntegrationEnvLiveRefresher');
export interface IIntegrationEnvLiveRefresher {
    /** Re-runs the toolkit's `set_integration_env()` in each notebook's running kernel (no restart); notifies once. */
    refresh(notebooks: readonly NotebookDocument[]): Promise<void>;
}

/** Persisted federated-auth token entry; fingerprints `${clientId}|${clientSecret}|${project}` to detect stale tokens. Only the refresh token is persisted. */
export interface FederatedAuthTokenEntry {
    integrationId: string;
    refreshToken: string;
    metadataFingerprint: string;
}

/** OAuth-client metadata fingerprinted by {@link IFederatedAuthTokenStorage.computeMetadataFingerprint}; mirrors the BigQuery `google-oauth` schema. */
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
    /** Canonical fingerprint of OAuth-client metadata. Exposed on the interface so cross-platform callers (e.g. `IntegrationWebviewProvider`) avoid the node-only helper. */
    computeMetadataFingerprint(metadata: FederatedAuthFingerprintInput): string;
    delete(integrationId: string): Promise<void>;
    get(integrationId: string): Promise<FederatedAuthTokenEntry | undefined>;
    has(integrationId: string): Promise<boolean>;
    /** All integration IDs with a stored token entry; used for orphaned-token cleanup. */
    listIntegrationIds(): Promise<string[]>;
    /** Persists a token entry. Pass `silent: true` for refresh-token rotation to skip `onDidChangeTokens` (avoids interrupting in-flight SQL cells). */
    save(entry: FederatedAuthTokenEntry, options?: { silent?: boolean }): Promise<void>;
}

export const IFederatedAuthSqlBlockCodeGenerator = Symbol('IFederatedAuthSqlBlockCodeGenerator');
export interface IFederatedAuthSqlBlockCodeGenerator {
    generate(block: DeepnoteBlock): Promise<string | undefined>;
}

/** Thrown when a federated integration has no usable refresh token (not authenticated yet, fingerprint mismatch, or `invalid_grant`). */
export class NotAuthenticatedError extends Error {
    constructor(public readonly integrationName: string) {
        super(`Integration "${integrationName}" is not authenticated.`);
        this.name = 'NotAuthenticatedError';
    }
}

/**
 * Thrown when OAuth client metadata (clientId/clientSecret) is wrong — `invalid_client` / `unauthorized_client`.
 * Distinct from {@link NotAuthenticatedError}: re-auth won't fix it. Lives here (not in `.node.ts`) so cross-platform callers can `instanceof`-check.
 */
export class OAuthClientMisconfiguredError extends Error {
    constructor(public readonly integrationName: string) {
        super(`OAuth client for integration "${integrationName}" is misconfigured.`);
        this.name = 'OAuthClientMisconfiguredError';
    }
}
