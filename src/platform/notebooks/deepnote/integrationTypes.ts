/**
 * Special integration ID that should be excluded from management.
 * This is the internal DuckDB integration that doesn't require configuration.
 */
export const DATAFRAME_SQL_INTEGRATION_ID = 'deepnote-dataframe-sql';

/**
 * Supported integration types
 */
export enum LegacyIntegrationType {
    Postgres = 'postgres',
    BigQuery = 'bigquery',
    Snowflake = 'snowflake',
    DuckDB = 'duckdb'
}

/**
 * Map our IntegrationType enum to Deepnote integration type strings
 * Note: DuckDB is not included as it's an internal integration that doesn't exist in Deepnote
 */
export const LEGACY_INTEGRATION_TYPE_TO_DEEPNOTE = {
    [LegacyIntegrationType.Postgres]: 'pgsql',
    [LegacyIntegrationType.BigQuery]: 'big-query',
    [LegacyIntegrationType.Snowflake]: 'snowflake'
} as const satisfies { [type in Exclude<LegacyIntegrationType, LegacyIntegrationType.DuckDB>]: string };

export type RawLegacyIntegrationType =
    (typeof LEGACY_INTEGRATION_TYPE_TO_DEEPNOTE)[keyof typeof LEGACY_INTEGRATION_TYPE_TO_DEEPNOTE];

/**
 * Map Deepnote integration type strings to our IntegrationType enum
 */
export const DEEPNOTE_TO_LEGACY_INTEGRATION_TYPE: Record<RawLegacyIntegrationType, LegacyIntegrationType> = {
    pgsql: LegacyIntegrationType.Postgres,
    'big-query': LegacyIntegrationType.BigQuery,
    snowflake: LegacyIntegrationType.Snowflake
};

/**
 * Base interface for all integration configurations
 */
export interface BaseLegacyIntegrationConfig {
    id: string;
    name: string;
    type: LegacyIntegrationType;
}

/**
 * PostgreSQL integration configuration
 */
export interface LegacyPostgresIntegrationConfig extends BaseLegacyIntegrationConfig {
    type: LegacyIntegrationType.Postgres;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl?: boolean;
}

/**
 * BigQuery integration configuration
 */
export interface LegacyBigQueryIntegrationConfig extends BaseLegacyIntegrationConfig {
    type: LegacyIntegrationType.BigQuery;
    projectId: string;
    credentials: string; // JSON string of service account credentials
}

/**
 * DuckDB integration configuration (internal, always available)
 */
export interface LegacyDuckDBIntegrationConfig extends BaseLegacyIntegrationConfig {
    type: LegacyIntegrationType.DuckDB;
}

import {
    BigQueryAuthMethods,
    DatabaseIntegrationConfig,
    DatabaseIntegrationType,
    databaseIntegrationTypes,
    FederatedAuthMethod,
    isFederatedAuthMethod
} from '@deepnote/database-integrations';
// Import and re-export Snowflake auth constants from shared module
import {
    type SnowflakeAuthMethod,
    SnowflakeAuthMethods,
    SUPPORTED_SNOWFLAKE_AUTH_METHODS,
    isSupportedSnowflakeAuthMethod
} from './snowflakeAuthConstants';
export {
    type SnowflakeAuthMethod,
    SnowflakeAuthMethods,
    SUPPORTED_SNOWFLAKE_AUTH_METHODS,
    isSupportedSnowflakeAuthMethod
};

/**
 * Base Snowflake configuration with common fields
 */
interface BaseLegacySnowflakeConfig extends BaseLegacyIntegrationConfig {
    type: LegacyIntegrationType.Snowflake;
    account: string;
    warehouse?: string;
    database?: string;
    role?: string;
}

/**
 * Snowflake integration configuration (discriminated union)
 */
export type LegacySnowflakeIntegrationConfig = BaseLegacySnowflakeConfig &
    (
        | {
              authMethod: typeof SnowflakeAuthMethods.PASSWORD | null;
              username: string;
              password: string;
          }
        | {
              authMethod: typeof SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR;
              username: string;
              privateKey: string;
              privateKeyPassphrase?: string;
          }
        | {
              // Unsupported auth methods - we store them but don't allow editing
              authMethod:
                  | typeof SnowflakeAuthMethods.OKTA
                  | typeof SnowflakeAuthMethods.NATIVE_SNOWFLAKE
                  | typeof SnowflakeAuthMethods.AZURE_AD
                  | typeof SnowflakeAuthMethods.KEY_PAIR;
              [key: string]: unknown; // Allow any additional fields for unsupported methods
          }
    );

/**
 * Union type of all integration configurations
 */
export type LegacyIntegrationConfig =
    | LegacyPostgresIntegrationConfig
    | LegacyBigQueryIntegrationConfig
    | LegacySnowflakeIntegrationConfig
    | LegacyDuckDBIntegrationConfig;

export type ConfigurableDatabaseIntegrationConfig = Extract<
    DatabaseIntegrationConfig,
    { type: ConfigurableDatabaseIntegrationType }
>;

export type ConfigurableDatabaseIntegrationType = Exclude<DatabaseIntegrationType, 'pandas-dataframe'>;

/** Narrows a raw type string to one the webview can configure; excludes the internal DuckDB integration. */
export function isConfigurableDatabaseIntegrationType(
    type: string | undefined
): type is ConfigurableDatabaseIntegrationType {
    return (
        type !== undefined &&
        type !== 'pandas-dataframe' &&
        (databaseIntegrationTypes as readonly string[]).includes(type)
    );
}

/** Federated-auth token status: `'authenticated'`, `'disconnected'` (federated but no token), or `'unsupported'` (non-federated or web/remote). */
export type FederatedAuthTokenStatus = 'authenticated' | 'disconnected' | 'unsupported';

/**
 * An integration declared by a project, paired with the credentials stored for it (if any)
 */
export interface DetectedIntegration {
    config: ConfigurableDatabaseIntegrationConfig | null;
    /**
     * Name from the project's integrations list (used for prefilling when config is null)
     */
    integrationName?: string;
    /**
     * Type from the project's integrations list (used for prefilling when config is null)
     */
    integrationType?: ConfigurableDatabaseIntegrationType;
    /**
     * `.deepnote.env.yaml` supplies this integration's config. The panel only ever edits SecretStorage, and the
     * file wins the merge, so anything saved from here would be silently overridden — the row is read-only.
     */
    isFileConfigured?: boolean;
    /** Federated-auth token status; only meaningful for federated integrations (currently BigQuery + `google-oauth`). */
    tokenStatus?: FederatedAuthTokenStatus;
}

/**
 * Narrows integration metadata to the federated-auth variant. Shared by the file-config provider and the SQL
 * env-vars provider (upstream `isFederatedAuthMetadata`'s generic doesn't unify with our
 * `DatabaseIntegrationConfig['metadata']` union); delegates to the exported `isFederatedAuthMethod` at runtime.
 */
export function isFederatedAuthMetadata(
    metadata: DatabaseIntegrationConfig['metadata']
): metadata is Extract<DatabaseIntegrationConfig['metadata'], { authMethod: FederatedAuthMethod }> {
    if (typeof metadata !== 'object' || metadata === null) {
        return false;
    }
    if (!('authMethod' in metadata)) {
        return false;
    }
    const authMethod = metadata.authMethod;

    return typeof authMethod === 'string' && isFederatedAuthMethod(authMethod);
}

/** The only federated combination this extension implements — see `FederatedAuthSqlBlockCodeGenerator`. */
export function isSupportedFederatedAuth(integration: DatabaseIntegrationConfig): boolean {
    return integration.type === 'big-query' && integration.metadata.authMethod === BigQueryAuthMethods.GoogleOauth;
}
