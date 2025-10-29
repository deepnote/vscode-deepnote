import {
    SnowflakeAuthMethod,
    SnowflakeAuthMethods,
    SUPPORTED_SNOWFLAKE_AUTH_METHODS,
    isSupportedSnowflakeAuthMethod
} from '../../../platform/notebooks/deepnote/snowflakeAuthConstants';

export type IntegrationType = 'postgres' | 'bigquery' | 'snowflake';

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

// Re-export Snowflake auth constants for convenience
export { SnowflakeAuthMethod, SnowflakeAuthMethods, SUPPORTED_SNOWFLAKE_AUTH_METHODS, isSupportedSnowflakeAuthMethod };

export interface BaseIntegrationConfig {
    id: string;
    name: string;
    type: IntegrationType;
}

export interface PostgresIntegrationConfig extends BaseIntegrationConfig {
    type: 'postgres';
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl?: boolean;
}

export interface BigQueryIntegrationConfig extends BaseIntegrationConfig {
    type: 'bigquery';
    projectId: string;
    credentials: string;
}

/**
 * Base Snowflake configuration with common fields
 */
interface BaseSnowflakeConfig extends BaseIntegrationConfig {
    type: 'snowflake';
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

export type IntegrationConfig = PostgresIntegrationConfig | BigQueryIntegrationConfig | SnowflakeIntegrationConfig;

export interface IntegrationWithStatus {
    id: string;
    config: IntegrationConfig | null;
    status: IntegrationStatus;
    integrationName?: string;
    integrationType?: IntegrationType;
}

export interface IVsCodeMessage {
    type: string;
    integrationId?: string;
    config?: IntegrationConfig;
}

export interface UpdateMessage {
    type: 'update';
    integrations: IntegrationWithStatus[];
}

export interface ShowFormMessage {
    type: 'showForm';
    integrationId: string;
    config: IntegrationConfig | null;
    integrationName?: string;
    integrationType?: IntegrationType;
}

export interface StatusMessage {
    type: 'success' | 'error';
    message: string;
}

export interface LocInitMessage {
    type: 'loc_init';
    locStrings: Partial<import('../../../messageTypes').LocalizedMessages>;
}

export type WebviewMessage = UpdateMessage | ShowFormMessage | StatusMessage | LocInitMessage;
