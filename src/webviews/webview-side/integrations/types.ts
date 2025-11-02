import { DatabaseIntegrationConfig, type DatabaseIntegrationType } from '@deepnote/database-integrations';

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

export interface IntegrationWithStatus {
    id: string;
    config: DatabaseIntegrationConfig | null;
    status: IntegrationStatus;
    integrationName?: string;
    integrationType?: DatabaseIntegrationType;
}

export interface IVsCodeMessage {
    type: string;
    integrationId?: string;
    config?: DatabaseIntegrationConfig;
}

export interface UpdateMessage {
    type: 'update';
    integrations: IntegrationWithStatus[];
}

export interface ShowFormMessage {
    type: 'showForm';
    integrationId: string;
    config: DatabaseIntegrationConfig | null;
    integrationName?: string;
    integrationType?: DatabaseIntegrationType;
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
