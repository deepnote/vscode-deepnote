import { DatabaseIntegrationConfig, type DatabaseIntegrationType } from '@deepnote/database-integrations';

export type ConfigurableDatabaseIntegrationType = Exclude<DatabaseIntegrationType, 'pandas-dataframe'>;

export type ConfigurableDatabaseIntegrationConfig = Exclude<DatabaseIntegrationConfig, { type: 'pandas-dataframe' }>;

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

/**
 * Federated-auth token status for an integration.
 *
 * Mirrors `FederatedAuthTokenStatus` in
 * `src/platform/notebooks/deepnote/integrationTypes.ts`. The webview is
 * bundled separately from the extension host, so the type is duplicated
 * here rather than imported across the bundle boundary.
 */
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

// Outbound (webview -> extension). Dispatched in `integrationWebview.ts:handleMessage`.
// Keep this discriminated union exhaustive — every webview-side `postMessage` should
// produce a value of this type, and the extension-side handler should switch on `type`.
export type WebviewOutboundMessage =
    | { type: 'configure'; integrationId: string }
    | { type: 'save'; integrationId: string; config: ConfigurableDatabaseIntegrationConfig }
    | { type: 'reset'; integrationId: string }
    | { type: 'delete'; integrationId: string }
    | AuthenticateMessage;
