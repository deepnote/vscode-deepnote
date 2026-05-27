// Shared test fixtures and helpers for the federated-auth tests + adjacent integration tests.
// Cross-platform: must not import from `.node.ts` modules. Node-only helpers live in `federatedAuthTestHelpers.node.ts`.

import type { DeepnoteBlock } from '@deepnote/blocks';

import type { ConfigurableDatabaseIntegrationConfig } from '../../../../platform/notebooks/deepnote/integrationTypes';
import type { DeepnoteProject } from '../../../../platform/deepnote/deepnoteTypes';
import type { FederatedAuthTokenEntry } from '../types';

const DEFAULT_SETTLE_DELAY_MS = 10;

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

export function settleAsyncHandlers(ms = DEFAULT_SETTLE_DELAY_MS): Promise<void> {
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
