// Shared test fixtures and helpers for the federated-auth tests + adjacent integration tests.
// Cross-platform: must not import from `.node.ts` modules. Node-only helpers live in `federatedAuthTestHelpers.node.ts`.

import type { DeepnoteBlock } from '@deepnote/blocks';
import sinon from 'sinon';
import { EventEmitter } from 'vscode';

import type { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';
import type { DeepnoteProject } from '../../../../platform/deepnote/deepnoteTypes';
import type { IIntegrationStorage } from '../../../../platform/notebooks/deepnote/types';
import type { FederatedAuthTokenEntry, IFederatedAuthTokenStorage } from '../types';

export const FED_AUTH_FIXTURE = {
    INTEGRATION_ID: 'bq-integration-1',
    PROJECT: 'my-gcp-project',
    CLIENT_ID: 'client-id-abc',
    CLIENT_SECRET: 'client-secret-xyz',
    REFRESH_TOKEN: 'refresh-token-abc',
    ACCESS_TOKEN: 'access-token-secret-do-not-log'
} as const;

export function buildGoogleOauthIntegration(
    overrides: Partial<ConfigurableDatabaseIntegrationConfig> = {}
): ConfigurableDatabaseIntegrationConfig {
    return {
        id: FED_AUTH_FIXTURE.INTEGRATION_ID,
        name: 'My BigQuery',
        type: 'big-query',
        metadata: {
            authMethod: 'google-oauth',
            project: FED_AUTH_FIXTURE.PROJECT,
            clientId: FED_AUTH_FIXTURE.CLIENT_ID,
            clientSecret: FED_AUTH_FIXTURE.CLIENT_SECRET
        },
        ...overrides
    } as ConfigurableDatabaseIntegrationConfig;
}

export function buildServiceAccountIntegration(
    overrides: Partial<ConfigurableDatabaseIntegrationConfig> = {}
): ConfigurableDatabaseIntegrationConfig {
    return {
        id: FED_AUTH_FIXTURE.INTEGRATION_ID,
        name: 'My SA BigQuery',
        type: 'big-query',
        metadata: {
            authMethod: 'service-account',
            service_account: '{"type":"service_account"}'
        },
        ...overrides
    } as ConfigurableDatabaseIntegrationConfig;
}

export function buildPostgresIntegration(
    overrides: Partial<ConfigurableDatabaseIntegrationConfig> = {}
): ConfigurableDatabaseIntegrationConfig {
    return {
        id: 'pg-1',
        name: 'My Postgres',
        type: 'pgsql',
        metadata: {
            host: 'localhost',
            port: '5432',
            database: 'db',
            user: 'u',
            password: 'p',
            sslEnabled: false
        },
        ...overrides
    } as ConfigurableDatabaseIntegrationConfig;
}

export function buildTokenEntry(overrides: Partial<FederatedAuthTokenEntry> = {}): FederatedAuthTokenEntry {
    return {
        integrationId: FED_AUTH_FIXTURE.INTEGRATION_ID,
        refreshToken: FED_AUTH_FIXTURE.REFRESH_TOKEN,
        metadataFingerprint: 'fp',
        ...overrides
    };
}

export function buildSqlBlock(
    overrides: {
        id?: string;
        content?: string;
        sql_integration_id?: string;
        deepnote_variable_name?: string;
        metadata?: Record<string, unknown>;
    } = {}
): DeepnoteBlock {
    return {
        id: overrides.id ?? 'block-1',
        type: 'sql',
        blockGroup: 'group-1',
        sortingKey: '0',
        content: overrides.content ?? 'SELECT 1 AS one',
        metadata: overrides.metadata ?? {
            sql_integration_id: overrides.sql_integration_id ?? FED_AUTH_FIXTURE.INTEGRATION_ID,
            deepnote_variable_name: overrides.deepnote_variable_name
        }
    } as unknown as DeepnoteBlock;
}

export function buildCodeBlock(): DeepnoteBlock {
    return {
        id: 'block-1',
        type: 'code',
        blockGroup: 'group-1',
        sortingKey: '0',
        content: 'print("hi")',
        metadata: {}
    } as unknown as DeepnoteBlock;
}

export interface FakeIntegrationStorage {
    addIntegration(config: ConfigurableDatabaseIntegrationConfig): void;
    integrationStore: Map<string, ConfigurableDatabaseIntegrationConfig>;
    onDidChangeIntegrations: EventEmitter<void>;
    removeIntegration(id: string): void;
    storage: IIntegrationStorage;
}

export function createFakeIntegrationStorage(): FakeIntegrationStorage {
    const integrationStore = new Map<string, ConfigurableDatabaseIntegrationConfig>();
    const onDidChangeIntegrations = new EventEmitter<void>();
    const storage: IIntegrationStorage = {
        onDidChangeIntegrations: onDidChangeIntegrations.event,
        dispose: () => onDidChangeIntegrations.dispose(),
        async clear() {
            integrationStore.clear();
            onDidChangeIntegrations.fire();
        },
        async delete(integrationId: string) {
            integrationStore.delete(integrationId);
            onDidChangeIntegrations.fire();
        },
        async exists(integrationId: string) {
            return integrationStore.has(integrationId);
        },
        async getAll() {
            return Array.from(integrationStore.values());
        },
        async getIntegrationConfig(integrationId: string) {
            return integrationStore.get(integrationId);
        },
        async getProjectIntegrationConfig() {
            return undefined;
        },
        async save(config: ConfigurableDatabaseIntegrationConfig) {
            integrationStore.set(config.id, config);
            onDidChangeIntegrations.fire();
        }
    };
    return {
        addIntegration: (config) => integrationStore.set(config.id, config),
        integrationStore,
        onDidChangeIntegrations,
        removeIntegration: (id) => integrationStore.delete(id),
        storage
    };
}

export interface FakeTokenStorage {
    deletedIds: string[];
    deleteSpy: sinon.SinonSpy;
    fingerprintForTest(m: { clientId: string; clientSecret: string; project: string }): string;
    onDidChangeEmitter: EventEmitter<string>;
    saveCallArgs: Array<[FederatedAuthTokenEntry, { silent?: boolean } | undefined]>;
    saveSpy: sinon.SinonSpy;
    savedTokens: FederatedAuthTokenEntry[];
    storage: IFederatedAuthTokenStorage;
    tokens: Map<string, FederatedAuthTokenEntry>;
}

export function createFakeTokenStorage(opts?: {
    fingerprintForTest?: (m: { clientId: string; clientSecret: string; project: string }) => string;
    throwOnDelete?: Set<string>;
}): FakeTokenStorage {
    const tokens = new Map<string, FederatedAuthTokenEntry>();
    const savedTokens: FederatedAuthTokenEntry[] = [];
    const saveCallArgs: Array<[FederatedAuthTokenEntry, { silent?: boolean } | undefined]> = [];
    const deletedIds: string[] = [];
    const onDidChangeEmitter = new EventEmitter<string>();
    const fingerprintForTest = opts?.fingerprintForTest ?? ((m) => `${m.clientId}|${m.clientSecret}|${m.project}`);

    const saveSpy = sinon.spy(async (entry: FederatedAuthTokenEntry, options?: { silent?: boolean }) => {
        tokens.set(entry.integrationId, entry);
        savedTokens.push(entry);
        saveCallArgs.push([entry, options]);
        if (!options?.silent) {
            onDidChangeEmitter.fire(entry.integrationId);
        }
    });
    const deleteSpy = sinon.spy(async (id: string) => {
        deletedIds.push(id);
        if (opts?.throwOnDelete?.has(id)) {
            throw new Error(`forced throw on delete: ${id}`);
        }
        const had = tokens.delete(id);
        if (had) {
            onDidChangeEmitter.fire(id);
        }
    });

    const storage: IFederatedAuthTokenStorage = {
        onDidChangeTokens: onDidChangeEmitter.event,
        computeMetadataFingerprint(metadata) {
            return fingerprintForTest(metadata);
        },
        async delete(integrationId: string) {
            await deleteSpy(integrationId);
        },
        async get(integrationId: string) {
            return tokens.get(integrationId);
        },
        async has(integrationId: string) {
            return tokens.has(integrationId);
        },
        async listIntegrationIds() {
            return Array.from(tokens.keys());
        },
        async save(entry: FederatedAuthTokenEntry, options?: { silent?: boolean }) {
            await saveSpy(entry, options);
        }
    };

    return {
        deletedIds,
        deleteSpy,
        fingerprintForTest,
        onDidChangeEmitter,
        saveCallArgs,
        saveSpy,
        savedTokens,
        storage,
        tokens
    };
}

export function createMockProject(projectId: string, integrationIds: string[] = []): DeepnoteProject {
    return {
        metadata: {
            createdAt: '2023-01-01T00:00:00Z',
            modifiedAt: '2023-01-02T00:00:00Z'
        },
        project: {
            id: projectId,
            name: 'Test Project',
            notebooks: [],
            integrations: integrationIds.map((id) => ({ id, name: id, type: 'big-query' as const }))
        },
        version: '1.0.0'
    };
}

export function settleAsyncHandlers(ms = 10): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Inverse of `escapePythonString`: parses a Python single-quoted literal back to its source string. */
export function parsePythonSingleQuoted(escaped: string): string {
    if (!escaped.startsWith("'") || !escaped.endsWith("'")) {
        throw new Error('must be wrapped in single quotes');
    }
    const body = escaped.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '\\' && i + 1 < body.length) {
            const next = body[i + 1];
            if (next === '\\') {
                out += '\\';
            } else if (next === "'") {
                out += "'";
            } else if (next === 'n') {
                out += '\n';
            } else {
                out += '\\' + next;
            }
            i++;
        } else {
            out += body[i];
        }
    }
    return out;
}
