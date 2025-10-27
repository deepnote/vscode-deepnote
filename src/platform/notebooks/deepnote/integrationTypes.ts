/**
 * Special integration ID that should be excluded from management.
 * This is the internal DuckDB integration that doesn't require configuration.
 */
export const DATAFRAME_SQL_INTEGRATION_ID = 'deepnote-dataframe-sql';

/**
 * Supported integration types
 */
export enum IntegrationType {
    Postgres = 'postgres',
    BigQuery = 'bigquery',
    Snowflake = 'snowflake'
}

/**
 * Map our IntegrationType enum to Deepnote integration type strings
 */
export const INTEGRATION_TYPE_TO_DEEPNOTE = {
    [IntegrationType.Postgres]: 'pgsql',
    [IntegrationType.BigQuery]: 'big-query',
    [IntegrationType.Snowflake]: 'snowflake'
} as const satisfies { [type in IntegrationType]: string };

export type RawIntegrationType = (typeof INTEGRATION_TYPE_TO_DEEPNOTE)[keyof typeof INTEGRATION_TYPE_TO_DEEPNOTE];

/**
 * Map Deepnote integration type strings to our IntegrationType enum
 */
export const DEEPNOTE_TO_INTEGRATION_TYPE: Record<RawIntegrationType, IntegrationType> = {
    pgsql: IntegrationType.Postgres,
    'big-query': IntegrationType.BigQuery,
    snowflake: IntegrationType.Snowflake
};

/**
 * Base interface for all integration configurations
 */
export interface BaseIntegrationConfig {
    id: string;
    name: string;
    type: IntegrationType;
}

/**
 * PostgreSQL integration configuration
 */
export interface PostgresIntegrationConfig extends BaseIntegrationConfig {
    type: IntegrationType.Postgres;
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
export interface BigQueryIntegrationConfig extends BaseIntegrationConfig {
    type: IntegrationType.BigQuery;
    projectId: string;
    credentials: string; // JSON string of service account credentials
}

/**
 * Snowflake authentication methods
 */
export const SnowflakeAuthMethods = {
    PASSWORD: 'PASSWORD',
    OKTA: 'OKTA',
    NATIVE_SNOWFLAKE: 'NATIVE_SNOWFLAKE',
    AZURE_AD: 'AZURE_AD',
    KEY_PAIR: 'KEY_PAIR',
    SERVICE_ACCOUNT_KEY_PAIR: 'SERVICE_ACCOUNT_KEY_PAIR'
} as const;

export type SnowflakeAuthMethod = (typeof SnowflakeAuthMethods)[keyof typeof SnowflakeAuthMethods] | null;

/**
 * Supported auth methods that we can configure in VSCode
 */
export const SUPPORTED_SNOWFLAKE_AUTH_METHODS = [
    null, // Legacy username+password (no authMethod field)
    SnowflakeAuthMethods.PASSWORD,
    SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR
] as const;

/**
 * Base Snowflake configuration with common fields
 */
interface BaseSnowflakeConfig extends BaseIntegrationConfig {
    type: IntegrationType.Snowflake;
    account: string;
    warehouse?: string;
    database?: string;
    role?: string;
}

/**
 * Snowflake integration configuration (discriminated union)
 */
export type SnowflakeIntegrationConfig = BaseSnowflakeConfig &
    (
        | {
              authMethod: null;
              username: string;
              password: string;
          }
        | {
              authMethod: typeof SnowflakeAuthMethods.PASSWORD;
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
export type IntegrationConfig = PostgresIntegrationConfig | BigQueryIntegrationConfig | SnowflakeIntegrationConfig;

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
    config: IntegrationConfig | null;
    status: IntegrationStatus;
    error?: string;
    /**
     * Name from the project's integrations list (used for prefilling when config is null)
     */
    integrationName?: string;
    /**
     * Type from the project's integrations list (used for prefilling when config is null)
     */
    integrationType?: IntegrationType;
}
