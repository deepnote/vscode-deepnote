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

import { DatabaseIntegrationConfig, DatabaseIntegrationType } from '@deepnote/database-integrations';
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

/**
 * Integration connection status
 */
export enum IntegrationStatus {
    Connected = 'connected',
    Disconnected = 'disconnected',
    Error = 'error'
}

/**
 * Integration with its current status
 */
export interface IntegrationWithStatus {
    config: DatabaseIntegrationConfig | null;
    status: IntegrationStatus;
    error?: string;
    /**
     * Name from the project's integrations list (used for prefilling when config is null)
     */
    integrationName?: string;
    /**
     * Type from the project's integrations list (used for prefilling when config is null)
     */
    integrationType?: DatabaseIntegrationType;
}
