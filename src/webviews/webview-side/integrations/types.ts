export type IntegrationType = 'postgres' | 'bigquery';

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

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

export type IntegrationConfig = PostgresIntegrationConfig | BigQueryIntegrationConfig;

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
