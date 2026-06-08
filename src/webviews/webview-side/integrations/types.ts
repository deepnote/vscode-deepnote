import { DatabaseIntegrationConfig, type DatabaseIntegrationType } from '@deepnote/database-integrations';

// Pending addition to @deepnote/database-integrations; remove once the package includes 'cloud-sql'.
export interface CloudSqlIntegrationConfig {
    id: string;
    name: string;
    type: 'cloud-sql';
    metadata: {
        service_account: string;
    };
}

export type ConfigurableDatabaseIntegrationType = Exclude<DatabaseIntegrationType, 'pandas-dataframe'> | 'cloud-sql';

export type ConfigurableDatabaseIntegrationConfig =
    | Exclude<DatabaseIntegrationConfig, { type: 'pandas-dataframe' }>
    | CloudSqlIntegrationConfig;

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

/** Federated-auth token status; mirrors `FederatedAuthTokenStatus` in platform/integrationTypes.ts (duplicated because the webview bundles separately). */
export type FederatedAuthTokenStatus = 'authenticated' | 'disconnected' | 'unsupported';

export interface IntegrationWithStatus {
    id: string;
    config: ConfigurableDatabaseIntegrationConfig | null;
    status: IntegrationStatus;
    integrationName?: string;
    integrationType?: ConfigurableDatabaseIntegrationType;
    tokenStatus?: FederatedAuthTokenStatus;
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

// Inbound (extension -> webview). Consumed by `MessageEvent<WebviewMessage>` in the webview.
export type WebviewMessage = UpdateMessage | ShowFormMessage | StatusMessage | LocInitMessage;

export interface AuthenticateMessage {
    type: 'authenticate';
    integrationId: string;
}

// Outbound (webview -> extension); dispatched in `integrationWebview.ts:handleMessage`. Keep exhaustive.
export type WebviewOutboundMessage =
    | { type: 'configure'; integrationId: string }
    | { type: 'save'; integrationId: string; config: ConfigurableDatabaseIntegrationConfig }
    | { type: 'reset'; integrationId: string }
    | { type: 'delete'; integrationId: string }
    | AuthenticateMessage;
