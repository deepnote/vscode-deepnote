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
    BigQuery = 'bigquery'
}

/**
 * Map Deepnote integration type strings to our IntegrationType enum
 */
const DEEPNOTE_TO_INTEGRATION_TYPE: Record<string, IntegrationType> = {
    pgsql: IntegrationType.Postgres,
    'big-query': IntegrationType.BigQuery
};

export function mapDeepnoteIntegrationType(deepnoteType: string): IntegrationType | undefined {
    return DEEPNOTE_TO_INTEGRATION_TYPE[deepnoteType];
}

/**
 * Map our IntegrationType enum to Deepnote integration type strings
 */
const INTEGRATION_TYPE_TO_DEEPNOTE: Record<IntegrationType, string> = {
    [IntegrationType.Postgres]: 'pgsql',
    [IntegrationType.BigQuery]: 'big-query'
};

export function mapToDeepnoteIntegrationType(type: IntegrationType): string {
    return INTEGRATION_TYPE_TO_DEEPNOTE[type];
}

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
 * Union type of all integration configurations
 */
export type IntegrationConfig = PostgresIntegrationConfig | BigQueryIntegrationConfig;

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
