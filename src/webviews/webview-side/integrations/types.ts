import { DatabaseIntegrationConfig, type DatabaseIntegrationType } from '@deepnote/database-integrations';

export type ConfigurableDatabaseIntegrationType = Exclude<DatabaseIntegrationType, 'pandas-dataframe'>;

export type ConfigurableDatabaseIntegrationConfig = Exclude<DatabaseIntegrationConfig, { type: 'pandas-dataframe' }>;

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

export interface IntegrationWithStatus {
    id: string;
    config: ConfigurableDatabaseIntegrationConfig | null;
    status: IntegrationStatus;
    integrationName?: string;
    integrationType?: ConfigurableDatabaseIntegrationType;
}

export interface IVsCodeMessage {
    type: string;
    integrationId?: string;
    config?: DatabaseIntegrationConfig;
}

export interface UpdateMessage {
    type: 'update';
    integrations: IntegrationWithStatus[];
    projectName?: string;
}

export interface ShowFormMessage {
    type: 'showForm';
    integrationId: string;
    config: ConfigurableDatabaseIntegrationConfig | null;
    integrationName?: string;
    integrationType?: ConfigurableDatabaseIntegrationType;
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
