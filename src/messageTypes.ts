// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Uri } from 'vscode';
import type { KernelMessage } from '@jupyterlab/services';
import {
    IVariableExplorerHeight // eslint-disable-next-line
} from './webviews/webview-side/interactive-common/redux/reducers/types';
// eslint-disable-next-line
import { KernelSocketOptions } from './kernels/types';
import { IJupyterVariable, IJupyterVariablesRequest, IJupyterVariablesResponse } from './kernels/variables/types';
import { WidgetScriptSource } from './notebooks/controllers/ipywidgets/types';

export type NotifyIPyWidgetWidgetVersionNotSupportedAction = {
    moduleName: 'qgrid';
    moduleVersion: string;
};

export interface ILoadIPyWidgetClassFailureAction {
    className: string;
    moduleName: string;
    moduleVersion: string;
    isOnline: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error: any;
    timedout: boolean;
}

export type LoadIPyWidgetClassLoadAction = {
    className: string;
    moduleName: string;
    moduleVersion: string;
};

export enum InteractiveWindowMessages {
    RestartKernel = 'restart_kernel',
    SettingsUpdated = 'settings_updated',
    Started = 'started',
    ConvertUriForUseInWebViewRequest = 'ConvertUriForUseInWebViewRequest',
    ConvertUriForUseInWebViewResponse = 'ConvertUriForUseInWebViewResponse',
    Activate = 'activate',
    ShowDataViewer = 'show_data_explorer',
    GetVariablesRequest = 'get_variables_request',
    GetVariablesResponse = 'get_variables_response',
    VariableExplorerToggle = 'variable_explorer_toggle',
    SetVariableExplorerHeight = 'set_variable_explorer_height',
    VariableExplorerHeightResponse = 'variable_explorer_height_response',
    ForceVariableRefresh = 'force_variable_refresh',
    UpdateVariableViewExecutionCount = 'update_variable_view_execution_count',
    OpenLink = 'open_link',
    SavePng = 'save_png',
    VariablesComplete = 'variables_complete',
    IPyWidgetLoadSuccess = 'ipywidget_load_success',
    IPyWidgetLoadFailure = 'ipywidget_load_failure',
    IPyWidgetRenderFailure = 'ipywidget_render_failure',
    IPyWidgetUnhandledKernelMessage = 'ipywidget_unhandled_kernel_message',
    IPyWidgetWidgetVersionNotSupported = 'ipywidget_widget_version_not_supported',
    GetHTMLByIdRequest = 'get_html_by_id_request',
    GetHTMLByIdResponse = 'get_html_by_id_response'
}

export enum IPyWidgetMessages {
    IPyWidgets_Window_Alert = 'IPyWidgets_Window_Alert',
    IPyWidgets_Window_Open = 'IPyWidgets_Window_Open',
    IPyWidgets_logMessage = 'IPyWidgets_logMessage',
    IPyWidgets_IsReadyRequest = 'IPyWidgets_IsReadyRequest',
    IPyWidgets_AttemptToDownloadFailedWidgetsAgain = 'IPyWidgets_AttemptToDownloadFailedWidgetsAgain',
    IPyWidgets_IsOnline = 'IPyWidgets_IsOnline',
    IPyWidgets_Ready = 'IPyWidgets_Ready',
    IPyWidgets_Request_Widget_Version = 'IPyWidgets_Request_Widget_Version',
    IPyWidgets_Reply_Widget_Version = 'IPyWidgets_Reply_Widget_Version',
    IPyWidgets_onRestartKernel = 'IPyWidgets_onRestartKernel',
    IPyWidgets_onKernelChanged = 'IPyWidgets_onKernelChanged',
    /**
     * UI sends a request to extension to determine whether we have the source for any of the widgets.
     */
    IPyWidgets_WidgetScriptSourceRequest = 'IPyWidgets_WidgetScriptSourceRequest',
    /**
     * Extension sends response to the request with yes/no.
     */
    IPyWidgets_WidgetScriptSourceResponse = 'IPyWidgets_WidgetScriptSource_Response',
    IPyWidgets_BaseUrlResponse = 'IPyWidgets_BaseUrl_Response',
    IPyWidgets_msg = 'IPyWidgets_msg',
    IPyWidgets_binary_msg = 'IPyWidgets_binary_msg',
    // Message was received by the widget kernel and added to the msgChain queue for processing
    IPyWidgets_msg_received = 'IPyWidgets_msg_received',
    // IOPub message was fully handled by the widget kernel
    IPyWidgets_iopub_msg_handled = 'IPyWidgets_iopub_msg_handled',
    IPyWidgets_kernelOptions = 'IPyWidgets_kernelOptions',
    IPyWidgets_registerCommTarget = 'IPyWidgets_registerCommTarget',
    IPyWidgets_RegisterMessageHook = 'IPyWidgets_RegisterMessageHook',
    // Message sent when the extension has finished an operation requested by the kernel UI for processing a message
    IPyWidgets_ExtensionOperationHandled = 'IPyWidgets_ExtensionOperationHandled',
    IPyWidgets_RemoveMessageHook = 'IPyWidgets_RemoveMessageHook',
    IPyWidgets_MessageHookCall = 'IPyWidgets_MessageHookCall',
    IPyWidgets_MessageHookResult = 'IPyWidgets_MessageHookResult',
    IPyWidgets_mirror_execute = 'IPyWidgets_mirror_execute'
}

export enum SysInfoReason {
    Start,
    Restart
}

export interface IShowDataViewer {
    variable: IJupyterVariable;
    columnSize: number;
}

export interface IShowDataViewerFromVariablePanel {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    container: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    variable: any;
}

export enum SharedMessages {
    UpdateSettings = 'update_settings',
    Started = 'started',
    LocInit = 'loc_init'
}

export type LocalizedMessages = {
    collapseSingle: string;
    expandSingle: string;
    openExportFileYes: string;
    openExportFileNo: string;
    noRowsInDataViewer: string;
    sliceIndexError: string;
    sliceMismatchedAxesError: string;
    filterRowsTooltip: string;
    fetchingDataViewer: string;
    dataViewerHideFilters: string;
    dataViewerShowFilters: string;
    refreshDataViewer: string;
    clearFilters: string;
    sliceSummaryTitle: string;
    sliceData: string;
    sliceSubmitButton: string;
    sliceDropdownAxisLabel: string;
    sliceDropdownIndexLabel: string;
    variableExplorerNameColumn: string;
    variableExplorerTypeColumn: string;
    variableExplorerCountColumn: string;
    variableExplorerValueColumn: string;
    collapseVariableExplorerLabel: string;
    variableLoadingValue: string;
    showDataExplorerTooltip: string;
    noRowsInVariableExplorer: string;
    loadingRowsInVariableExplorer: string;
    previousPlot: string;
    nextPlot: string;
    panPlot: string;
    zoomInPlot: string;
    zoomOutPlot: string;
    exportPlot: string;
    deletePlot: string;
    selectedImageListLabel: string;
    selectedImageLabel: string;
    dvDeprecationWarning: string;
    dataframeRowsColumns: string;
    dataframePerPage: string;
    dataframePreviousPage: string;
    dataframeNextPage: string;
    dataframePageOf: string;
    dataframeCopyTable: string;
    dataframeExportTable: string;
    // Integration panel strings
    integrationsTitle: string;
    integrationsNoIntegrationsFound: string;
    integrationsConnected: string;
    integrationsConfiguredInFile: string;
    integrationsNotConfigured: string;
    integrationsConfigure: string;
    integrationsReconfigure: string;
    integrationsReset: string;
    integrationsSignOut: string;
    integrationsDelete: string;
    integrationsConfirmResetTitle: string;
    integrationsConfirmResetMessage: string;
    integrationsConfirmResetDetails: string;
    integrationsConfirmDeleteTitle: string;
    integrationsConfirmDeleteMessage: string;
    integrationsConfirmDeleteDetails: string;
    integrationsConfigureTitle: string;
    integrationsCancel: string;
    integrationsSave: string;
    integrationsAddNewIntegration: string;
    integrationsDatabase: string;
    integrationsDataWarehousesLakes: string;
    integrationsDatabases: string;
    // Integration type labels
    integrationsPostgresTypeLabel: string;
    integrationsBigQueryTypeLabel: string;
    integrationsSnowflakeTypeLabel: string;
    integrationsAlloyDBTypeLabel: string;
    integrationsAthenaTypeLabel: string;
    integrationsClickHouseTypeLabel: string;
    integrationsCloudSqlTypeLabel: string;
    integrationsDatabricksTypeLabel: string;
    integrationsDremioTypeLabel: string;
    integrationsMariaDBTypeLabel: string;
    integrationsMaterializeTypeLabel: string;
    integrationsMindsDBTypeLabel: string;
    integrationsMongoDBTypeLabel: string;
    integrationsMySQLTypeLabel: string;
    integrationsDuckDBTypeLabel: string;
    integrationsRedshiftTypeLabel: string;
    integrationsSpannerTypeLabel: string;
    integrationsSQLServerTypeLabel: string;
    integrationsTrinoTypeLabel: string;
    // PostgreSQL form strings
    integrationsPostgresNameLabel: string;
    integrationsPostgresNamePlaceholder: string;
    integrationsPostgresHostLabel: string;
    integrationsPostgresHostPlaceholder: string;
    integrationsPostgresPortLabel: string;
    integrationsPostgresPortPlaceholder: string;
    integrationsPostgresDatabaseLabel: string;
    integrationsPostgresDatabasePlaceholder: string;
    integrationsPostgresUsernameLabel: string;
    integrationsPostgresUsernamePlaceholder: string;
    integrationsPostgresPasswordLabel: string;
    integrationsPostgresPasswordPlaceholder: string;
    integrationsPostgresSslLabel: string;
    // BigQuery form strings
    integrationsBigQueryNameLabel: string;
    integrationsBigQueryNamePlaceholder: string;
    integrationsBigQueryProjectIdLabel: string;
    integrationsBigQueryProjectIdPlaceholder: string;
    integrationsBigQueryCredentialsLabel: string;
    integrationsBigQueryCredentialsPlaceholder: string;
    integrationsBigQueryCredentialsRequired: string;
    // BigQuery federated-auth form strings
    integrationsBigQueryAuthMethodLabel: string;
    integrationsBigQueryAuthMethodServiceAccount: string;
    integrationsBigQueryAuthMethodGoogleOauth: string;
    integrationsBigQueryProjectLabel: string;
    integrationsBigQueryProjectPlaceholder: string;
    integrationsBigQueryClientIdLabel: string;
    integrationsBigQueryClientIdPlaceholder: string;
    integrationsBigQueryClientSecretLabel: string;
    integrationsBigQueryClientSecretPlaceholder: string;
    // Federated-auth integration management strings
    integrationsAuthenticate: string;
    integrationsReauthenticate: string;
    integrationsTokenStatusAuthenticated: string;
    integrationsTokenStatusDisconnected: string;
    integrationsAuthenticating: string;
    integrationsAuthenticationSucceeded: string;
    integrationsAuthenticationFailed: string;
    integrationsBigQueryNotAuthenticated: string;
    integrationsFederatedAuthNotSupportedInWeb: string;
    // Snowflake form strings
    integrationsSnowflakeNameLabel: string;
    integrationsSnowflakeNamePlaceholder: string;
    integrationsSnowflakeAccountLabel: string;
    integrationsSnowflakeAccountPlaceholder: string;
    integrationsSnowflakeAuthMethodLabel: string;
    integrationsSnowflakeAuthMethodSubLabel: string;
    integrationsSnowflakeAuthMethodUsernamePassword: string;
    integrationsSnowflakeAuthMethodKeyPair: string;
    integrationsSnowflakeUnsupportedAuthMethod: string;
    integrationsSnowflakeUsernameLabel: string;
    integrationsSnowflakePasswordLabel: string;
    integrationsSnowflakePasswordPlaceholder: string;
    integrationsSnowflakeServiceAccountUsernameLabel: string;
    integrationsSnowflakeServiceAccountUsernameHelp: string;
    integrationsSnowflakePrivateKeyLabel: string;
    integrationsSnowflakePrivateKeyHelp: string;
    integrationsSnowflakePrivateKeyPlaceholder: string;
    integrationsSnowflakePrivateKeyPassphraseLabel: string;
    integrationsSnowflakePrivateKeyPassphraseHelp: string;
    integrationsSnowflakeDatabaseLabel: string;
    integrationsSnowflakeDatabasePlaceholder: string;
    integrationsSnowflakeRoleLabel: string;
    integrationsSnowflakeRolePlaceholder: string;
    integrationsSnowflakeWarehouseLabel: string;
    integrationsSnowflakeWarehousePlaceholder: string;
    // MySQL form strings
    integrationsMySQLNameLabel: string;
    integrationsMySQLNamePlaceholder: string;
    integrationsMySQLHostLabel: string;
    integrationsMySQLHostPlaceholder: string;
    integrationsMySQLPortLabel: string;
    integrationsMySQLDatabaseLabel: string;
    integrationsMySQLDatabasePlaceholder: string;
    integrationsMySQLUsernameLabel: string;
    integrationsMySQLUsernamePlaceholder: string;
    integrationsMySQLPasswordLabel: string;
    integrationsMySQLPasswordPlaceholder: string;
    // MariaDB form strings
    integrationsMariaDBNameLabel: string;
    integrationsMariaDBNamePlaceholder: string;
    integrationsMariaDBHostLabel: string;
    integrationsMariaDBHostPlaceholder: string;
    integrationsMariaDBPortLabel: string;
    integrationsMariaDBDatabaseLabel: string;
    integrationsMariaDBDatabasePlaceholder: string;
    integrationsMariaDBUsernameLabel: string;
    integrationsMariaDBUsernamePlaceholder: string;
    integrationsMariaDBPasswordLabel: string;
    integrationsMariaDBPasswordPlaceholder: string;
    // Athena form strings
    integrationsAthenaNameLabel: string;
    integrationsAthenaNamePlaceholder: string;
    integrationsAthenaAccessKeyIdLabel: string;
    integrationsAthenaAccessKeyIdPlaceholder: string;
    integrationsAthenaSecretAccessKeyLabel: string;
    integrationsAthenaSecretAccessKeyPlaceholder: string;
    integrationsAthenaRegionLabel: string;
    integrationsAthenaRegionPlaceholder: string;
    integrationsAthenaS3OutputPathLabel: string;
    integrationsAthenaS3OutputPathPlaceholder: string;
    integrationsAthenaWorkgroupLabel: string;
    integrationsAthenaWorkgroupPlaceholder: string;
    // Databricks form strings
    integrationsDatabricksNameLabel: string;
    integrationsDatabricksNamePlaceholder: string;
    integrationsDatabricksHostLabel: string;
    integrationsDatabricksHostPlaceholder: string;
    integrationsDatabricksHttpPathLabel: string;
    integrationsDatabricksHttpPathPlaceholder: string;
    integrationsDatabricksTokenLabel: string;
    integrationsDatabricksTokenPlaceholder: string;
    integrationsDatabricksPortLabel: string;
    integrationsDatabricksCatalogLabel: string;
    integrationsDatabricksCatalogPlaceholder: string;
    integrationsDatabricksSchemaLabel: string;
    integrationsDatabricksSchemaPlaceholder: string;
    // Dremio form strings
    integrationsDremioNameLabel: string;
    integrationsDremioNamePlaceholder: string;
    integrationsDremioHostLabel: string;
    integrationsDremioHostPlaceholder: string;
    integrationsDremioPortLabel: string;
    integrationsDremioSchemaLabel: string;
    integrationsDremioSchemaPlaceholder: string;
    integrationsDremioTokenLabel: string;
    integrationsDremioTokenPlaceholder: string;
    // MongoDB form strings
    integrationsMongoDBNameLabel: string;
    integrationsMongoDBNamePlaceholder: string;
    integrationsMongoDBConnectionStringLabel: string;
    integrationsMongoDBConnectionStringPlaceholder: string;
    integrationsMongoDBConnectionStringHelp: string;
    integrationsMongoDBOptionalFieldsNote: string;
    integrationsMongoDBRawConnectionStringLabel: string;
    integrationsMongoDBPrefixLabel: string;
    integrationsMongoDBHostLabel: string;
    integrationsMongoDBPortLabel: string;
    integrationsMongoDBUserLabel: string;
    integrationsMongoDBPasswordLabel: string;
    integrationsMongoDBDatabaseLabel: string;
    integrationsMongoDBOptionsLabel: string;
    // Redshift form strings
    integrationsRedshiftNameLabel: string;
    integrationsRedshiftNamePlaceholder: string;
    integrationsRedshiftAuthMethodLabel: string;
    integrationsRedshiftAuthMethodUsernamePassword: string;
    integrationsRedshiftAuthMethodIndividualCredentials: string;
    integrationsRedshiftAuthMethodHelp: string;
    integrationsRedshiftHostLabel: string;
    integrationsRedshiftHostPlaceholder: string;
    integrationsRedshiftPortLabel: string;
    integrationsRedshiftDatabaseLabel: string;
    integrationsRedshiftDatabasePlaceholder: string;
    integrationsRedshiftUsernameLabel: string;
    integrationsRedshiftUsernamePlaceholder: string;
    integrationsRedshiftPasswordLabel: string;
    integrationsRedshiftPasswordPlaceholder: string;
    // Spanner form strings
    integrationsSpannerNameLabel: string;
    integrationsSpannerNamePlaceholder: string;
    integrationsSpannerInstanceLabel: string;
    integrationsSpannerInstancePlaceholder: string;
    integrationsSpannerDatabaseLabel: string;
    integrationsSpannerDatabasePlaceholder: string;
    integrationsSpannerServiceAccountLabel: string;
    integrationsSpannerServiceAccountPlaceholder: string;
    integrationsSpannerServiceAccountHelp: string;
    integrationsSpannerServiceAccountInvalidJson: string;
    integrationsSpannerServiceAccountRequired: string;
    integrationsSpannerDataBoostLabel: string;
    integrationsSpannerDataBoostHelp: string;
    // Cloud SQL form strings
    integrationsCloudSqlNameLabel: string;
    integrationsCloudSqlNamePlaceholder: string;
    integrationsCloudSqlServiceAccountLabel: string;
    integrationsCloudSqlServiceAccountPlaceholder: string;
    integrationsCloudSqlServiceAccountHelp: string;
    integrationsCloudSqlServiceAccountInvalidJson: string;
    integrationsCloudSqlServiceAccountRequired: string;
    // AlloyDB form strings
    integrationsAlloyDBNameLabel: string;
    integrationsAlloyDBNamePlaceholder: string;
    integrationsAlloyDBHostLabel: string;
    integrationsAlloyDBHostPlaceholder: string;
    integrationsAlloyDBPortLabel: string;
    integrationsAlloyDBDatabaseLabel: string;
    integrationsAlloyDBDatabasePlaceholder: string;
    integrationsAlloyDBUsernameLabel: string;
    integrationsAlloyDBUsernamePlaceholder: string;
    integrationsAlloyDBPasswordLabel: string;
    integrationsAlloyDBPasswordPlaceholder: string;
    // ClickHouse form strings
    integrationsClickHouseNameLabel: string;
    integrationsClickHouseNamePlaceholder: string;
    integrationsClickHouseHostLabel: string;
    integrationsClickHouseHostPlaceholder: string;
    integrationsClickHousePortLabel: string;
    integrationsClickHouseDatabaseLabel: string;
    integrationsClickHouseDatabasePlaceholder: string;
    integrationsClickHouseUsernameLabel: string;
    integrationsClickHouseUsernamePlaceholder: string;
    integrationsClickHousePasswordLabel: string;
    integrationsClickHousePasswordPlaceholder: string;
    // Materialize form strings
    integrationsMaterializeNameLabel: string;
    integrationsMaterializeNamePlaceholder: string;
    integrationsMaterializeHostLabel: string;
    integrationsMaterializeHostPlaceholder: string;
    integrationsMaterializePortLabel: string;
    integrationsMaterializeDatabaseLabel: string;
    integrationsMaterializeDatabasePlaceholder: string;
    integrationsMaterializeClusterLabel: string;
    integrationsMaterializeClusterPlaceholder: string;
    integrationsMaterializeUsernameLabel: string;
    integrationsMaterializeUsernamePlaceholder: string;
    integrationsMaterializePasswordLabel: string;
    integrationsMaterializePasswordPlaceholder: string;
    // MindsDB form strings
    integrationsMindsDBNameLabel: string;
    integrationsMindsDBNamePlaceholder: string;
    integrationsMindsDBHostLabel: string;
    integrationsMindsDBHostPlaceholder: string;
    integrationsMindsDBPortLabel: string;
    integrationsMindsDBDatabaseLabel: string;
    integrationsMindsDBDatabasePlaceholder: string;
    integrationsMindsDBUsernameLabel: string;
    integrationsMindsDBUsernamePlaceholder: string;
    integrationsMindsDBPasswordLabel: string;
    integrationsMindsDBPasswordPlaceholder: string;
    // SQL Server form strings
    integrationsSQLServerNameLabel: string;
    integrationsSQLServerNamePlaceholder: string;
    integrationsSQLServerHostLabel: string;
    integrationsSQLServerHostPlaceholder: string;
    integrationsSQLServerPortLabel: string;
    integrationsSQLServerDatabaseLabel: string;
    integrationsSQLServerDatabasePlaceholder: string;
    integrationsSQLServerUsernameLabel: string;
    integrationsSQLServerUsernamePlaceholder: string;
    integrationsSQLServerPasswordLabel: string;
    integrationsSQLServerPasswordPlaceholder: string;
    // Trino form strings
    integrationsTrinoNameLabel: string;
    integrationsTrinoNamePlaceholder: string;
    integrationsTrinoHostLabel: string;
    integrationsTrinoHostPlaceholder: string;
    integrationsTrinoPortLabel: string;
    integrationsTrinoDatabaseLabel: string;
    integrationsTrinoDatabasePlaceholder: string;
    integrationsTrinoUsernameLabel: string;
    integrationsTrinoUsernamePlaceholder: string;
    integrationsTrinoPasswordLabel: string;
    integrationsTrinoPasswordPlaceholder: string;
    // SSH options strings
    integrationsSshEnabled: string;
    integrationsSshHost: string;
    integrationsSshHostPlaceholder: string;
    integrationsSshPort: string;
    integrationsSshUser: string;
    integrationsSshUserPlaceholder: string;
    // SSL/CA certificate strings
    integrationsSslEnabled: string;
    integrationsCaCertificateName: string;
    integrationsCaCertificateNamePlaceholder: string;
    integrationsCaCertificateText: string;
    integrationsCaCertificateTextPlaceholder: string;
    // Common form strings
    integrationsRequiredField: string;
    integrationsOptionalField: string;
    integrationsUnnamedIntegration: string;
    integrationsDefaultName: string;
    integrationsUnsupportedIntegrationType: string;
    // Select input settings strings
    selectInputSettingsTitle: string;
    allowMultipleValues: string;
    allowEmptyValue: string;
    valueSourceTitle: string;
    fromOptions: string;
    fromOptionsDescription: string;
    addOptionPlaceholder: string;
    addButton: string;
    fromVariable: string;
    fromVariableDescription: string;
    variablePlaceholder: string;
    optionNameLabel: string;
    variableNameLabel: string;
    removeOptionAriaLabel: string;
    saveButton: string;
    cancelButton: string;
    failedToSave: string;
    // Big number comparison settings strings
    bigNumberComparisonTitle: string;
    enableComparison: string;
    comparisonTypeLabel: string;
    percentageChange: string;
    absoluteValue: string;
    comparisonValueLabel: string;
    comparisonValuePlaceholder: string;
    comparisonTitleLabel: string;
    comparisonTitlePlaceholder: string;
    comparisonTitleHelp: string;
    comparisonValueHelp: string;
    comparisonFormatLabel: string;
    comparisonFormatHelp: string;
};
// Map all messages to specific payloads
export class IInteractiveWindowMapping {
    public [IPyWidgetMessages.IPyWidgets_kernelOptions]: KernelSocketOptions;
    public [IPyWidgetMessages.IPyWidgets_WidgetScriptSourceRequest]: {
        moduleName: string;
        moduleVersion: string;
        requestId: string;
    };
    public [IPyWidgetMessages.IPyWidgets_WidgetScriptSourceResponse]: WidgetScriptSource;
    public [IPyWidgetMessages.IPyWidgets_Ready]: never | undefined;
    public [IPyWidgetMessages.IPyWidgets_IsOnline]: { isOnline: boolean };
    public [IPyWidgetMessages.IPyWidgets_logMessage]: { category: 'error' | 'verbose'; message: string };
    public [IPyWidgetMessages.IPyWidgets_onRestartKernel]: never | undefined;
    public [IPyWidgetMessages.IPyWidgets_onKernelChanged]: never | undefined;
    public [IPyWidgetMessages.IPyWidgets_registerCommTarget]: string;
    public [IPyWidgetMessages.IPyWidgets_binary_msg]:
        | ((ArrayBuffer | ArrayBufferView)[] | undefined)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        | { id: string; data: any };
    public [IPyWidgetMessages.IPyWidgets_msg]: { id: string; data: string };
    public [IPyWidgetMessages.IPyWidgets_msg_received]: { id: string };
    public [IPyWidgetMessages.IPyWidgets_iopub_msg_handled]: { id: string };
    public [IPyWidgetMessages.IPyWidgets_RegisterMessageHook]: string;
    public [IPyWidgetMessages.IPyWidgets_ExtensionOperationHandled]: { id: string; type: IPyWidgetMessages };
    public [IPyWidgetMessages.IPyWidgets_RemoveMessageHook]: { hookMsgId: string; lastHookedMsgId: string | undefined };
    public [IPyWidgetMessages.IPyWidgets_MessageHookCall]: {
        requestId: string;
        parentId: string;
        msg: KernelMessage.IIOPubMessage;
    };
    public [IPyWidgetMessages.IPyWidgets_MessageHookResult]: {
        requestId: string;
        parentId: string;
        msgType: string;
        result: boolean;
    };
    public [IPyWidgetMessages.IPyWidgets_mirror_execute]: { id: string; msg: KernelMessage.IExecuteRequestMsg };
    public [InteractiveWindowMessages.ForceVariableRefresh]: never | undefined;
    public [InteractiveWindowMessages.UpdateVariableViewExecutionCount]: { executionCount: number };
    public [InteractiveWindowMessages.RestartKernel]: never | undefined;
    public [InteractiveWindowMessages.SettingsUpdated]: string;
    public [InteractiveWindowMessages.Started]: never | undefined;
    public [InteractiveWindowMessages.Activate]: never | undefined;
    public [InteractiveWindowMessages.ShowDataViewer]: IShowDataViewer;
    public [InteractiveWindowMessages.GetVariablesRequest]: IJupyterVariablesRequest;
    public [InteractiveWindowMessages.GetVariablesResponse]: IJupyterVariablesResponse;
    public [InteractiveWindowMessages.VariableExplorerToggle]: boolean;
    public [InteractiveWindowMessages.SetVariableExplorerHeight]: IVariableExplorerHeight;
    public [InteractiveWindowMessages.VariableExplorerHeightResponse]: IVariableExplorerHeight;
    public [InteractiveWindowMessages.OpenLink]: string | undefined;
    public [InteractiveWindowMessages.SavePng]: string | undefined;
    public [InteractiveWindowMessages.VariablesComplete]: never | undefined;
    public [SharedMessages.UpdateSettings]: string;
    public [SharedMessages.LocInit]: string;
    public [InteractiveWindowMessages.IPyWidgetLoadSuccess]: LoadIPyWidgetClassLoadAction;
    public [InteractiveWindowMessages.IPyWidgetLoadFailure]: ILoadIPyWidgetClassFailureAction;
    public [InteractiveWindowMessages.IPyWidgetWidgetVersionNotSupported]: NotifyIPyWidgetWidgetVersionNotSupportedAction;
    public [InteractiveWindowMessages.ConvertUriForUseInWebViewRequest]: Uri;
    public [InteractiveWindowMessages.ConvertUriForUseInWebViewResponse]: { request: Uri; response: Uri };
    public [InteractiveWindowMessages.IPyWidgetRenderFailure]: Error;
    public [InteractiveWindowMessages.IPyWidgetUnhandledKernelMessage]: KernelMessage.IMessage;
    public [InteractiveWindowMessages.GetHTMLByIdRequest]: string;
    public [InteractiveWindowMessages.GetHTMLByIdResponse]: string;
}

export const enum ErrorRendererMessageType {
    RequestLoadLoc = 2,
    ResponseLoadLoc = 3
}
export type Localizations = {
    errorOutputExceedsLinkToOpenFormatString: string;
};
