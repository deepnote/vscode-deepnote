export type IntegrationType = 'postgres' | 'bigquery' | 'snowflake';

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

export type SnowflakeAuthMethod = 'username_password' | 'key_pair';

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

export interface SnowflakeIntegrationConfig extends BaseIntegrationConfig {
    type: 'snowflake';
    account: string;
    authMethod: SnowflakeAuthMethod;
    username: string;
    // For username+password auth
    password?: string;
    // For key-pair auth
    privateKey?: string;
    privateKeyPassphrase?: string;
    // Optional fields
    database?: string;
    warehouse?: string;
    role?: string;
}

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
