import { inject, injectable, optional } from 'inversify';
import { commands, Disposable, l10n, Uri, ViewColumn, WebviewPanel, window } from 'vscode';

import { BigQueryAuthMethods } from '@deepnote/database-integrations';

import { type CommandOutcome, ITelemetryService } from '../../../platform/analytics/types';
import { Commands } from '../../../platform/common/constants';
import { IDisposableRegistry, IExtensionContext } from '../../../platform/common/types';
import * as localize from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { LocalizedMessages, SharedMessages } from '../../../messageTypes';
import { ISqlIntegrationEnvVarsProvider } from '../../../platform/notebooks/deepnote/types';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { persistProjectIntegrations } from './projectIntegrationsWriter';
import { IFederatedAuthTokenStorage, IIntegrationStorage, IIntegrationWebviewProvider } from './types';
import {
    ConfigurableDatabaseIntegrationConfig,
    FederatedAuthTokenStatus,
    DetectedIntegration,
    isFederatedAuthMetadata
} from '../../../platform/notebooks/deepnote/integrationTypes';

/**
 * Manages the webview panel for integration configuration
 */
@injectable()
export class IntegrationWebviewProvider implements IIntegrationWebviewProvider {
    private activeFileUri: Uri | undefined;

    private currentPanel: WebviewPanel | undefined;

    private readonly disposables: Disposable[] = [];

    private integrations: Map<string, DetectedIntegration> = new Map();

    private projectId: string | undefined;

    private projectName: string | undefined;

    /** Generation counter for `updateWebview()` ("latest call wins"; stale in-flight updates bail). */
    private updateGeneration = 0;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(ITelemetryService) private readonly analytics: ITelemetryService,
        @inject(IDisposableRegistry) private readonly disposableRegistry: IDisposableRegistry,
        @inject(ISqlIntegrationEnvVarsProvider) private readonly sqlIntegrationEnvVars: ISqlIntegrationEnvVarsProvider,
        @inject(IFederatedAuthTokenStorage)
        @optional()
        private readonly tokenStorage?: IFederatedAuthTokenStorage
    ) {
        // Refresh on token-storage change so the auth pill flips without panel reload. Pushed into the extension-lifetime registry to survive panel close/reopen.
        if (this.tokenStorage) {
            this.disposableRegistry.push(
                this.tokenStorage.onDidChangeTokens(() => {
                    this.updateWebview().catch((err) => {
                        logger.error('IntegrationWebviewProvider: Failed to update webview', err);
                    });
                })
            );
        }
    }

    /**
     * Show the integration management webview
     * @param projectId The Deepnote project ID
     * @param integrations Map of integration IDs to their status
     * @param activeFileUri The `.deepnote` file being edited — always persisted to disk on save
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     * @param projectName Optional project display name (sourced from the active notebook's metadata)
     */
    public async show(
        projectId: string,
        integrations: Map<string, DetectedIntegration>,
        activeFileUri: Uri,
        selectedIntegrationId?: string,
        projectName?: string
    ): Promise<void> {
        // Update the stored integrations and project ID with the latest data
        this.activeFileUri = activeFileUri;
        this.projectId = projectId;
        this.projectName = projectName;
        this.integrations = integrations;

        const column = window.activeTextEditor ? window.activeTextEditor.viewColumn : ViewColumn.One;

        // If we already have a panel, show it
        if (this.currentPanel) {
            this.currentPanel.reveal(column);
            await this.updateWebview();

            // If a specific integration was requested, show its configuration form
            if (selectedIntegrationId) {
                await this.showConfigurationForm(selectedIntegrationId);
            }
            return;
        }

        // Create a new panel
        this.currentPanel = window.createWebviewPanel(
            'deepnoteIntegrations',
            'Deepnote Integrations',
            column || ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionContext.extensionUri],
                enableForms: true
            }
        );

        // Set the webview's initial html content
        this.currentPanel.webview.html = this.getWebviewContent();

        // Handle messages from the webview
        this.currentPanel.webview.onDidReceiveMessage(
            async (message) => {
                await this.handleMessage(message);
            },
            null,
            this.disposables
        );

        // Reset when the current panel is closed
        this.currentPanel.onDidDispose(
            () => {
                this.currentPanel = undefined;
                this.integrations = new Map();
                this.disposables.forEach((d) => d.dispose());
                this.disposables.length = 0;
            },
            null,
            this.disposables
        );

        await this.sendLocStrings();
        await this.updateWebview();

        // If a specific integration was requested, show its configuration form
        if (selectedIntegrationId) {
            await this.showConfigurationForm(selectedIntegrationId);
        }
    }

    /**
     * Send localization strings to the webview
     */
    private async sendLocStrings(): Promise<void> {
        if (!this.currentPanel) {
            return;
        }

        const locStrings: Partial<LocalizedMessages> = {
            integrationsTitle: localize.Integrations.title,
            integrationsNoIntegrationsFound: localize.Integrations.noIntegrationsFound,
            integrationsConnected: localize.Integrations.connected,
            integrationsConfiguredInFile: localize.Integrations.configuredInFile,
            integrationsNotConfigured: localize.Integrations.notConfigured,
            integrationsConfigure: localize.Integrations.configure,
            integrationsReconfigure: localize.Integrations.reconfigure,
            integrationsReset: localize.Integrations.reset,
            integrationsSignOut: localize.Integrations.signOut,
            integrationsDelete: localize.Integrations.deleteIntegration,
            integrationsConfirmResetTitle: localize.Integrations.confirmResetTitle,
            integrationsConfirmResetMessage: localize.Integrations.confirmResetMessage,
            integrationsConfirmResetDetails: localize.Integrations.confirmResetDetails,
            integrationsConfirmDeleteTitle: localize.Integrations.confirmDeleteTitle,
            integrationsConfirmDeleteMessage: localize.Integrations.confirmDeleteMessage,
            integrationsConfirmDeleteDetails: localize.Integrations.confirmDeleteDetails,
            integrationsConfigureTitle: localize.Integrations.configureTitle,
            integrationsAddNewIntegration: localize.Integrations.addNewIntegration,
            integrationsDatabase: localize.Integrations.database,
            integrationsDataWarehousesLakes: localize.Integrations.dataWarehousesLakes,
            integrationsDatabases: localize.Integrations.databases,
            integrationsPostgresTypeLabel: localize.Integrations.postgresTypeLabel,
            integrationsBigQueryTypeLabel: localize.Integrations.bigQueryTypeLabel,
            integrationsSnowflakeTypeLabel: localize.Integrations.snowflakeTypeLabel,
            integrationsAlloyDBTypeLabel: localize.Integrations.alloyDBTypeLabel,
            integrationsAthenaTypeLabel: localize.Integrations.athenaTypeLabel,
            integrationsClickHouseTypeLabel: localize.Integrations.clickHouseTypeLabel,
            integrationsCloudSqlTypeLabel: localize.Integrations.cloudSqlTypeLabel,
            integrationsDatabricksTypeLabel: localize.Integrations.databricksTypeLabel,
            integrationsDremioTypeLabel: localize.Integrations.dremioTypeLabel,
            integrationsMariaDBTypeLabel: localize.Integrations.mariaDBTypeLabel,
            integrationsMaterializeTypeLabel: localize.Integrations.materializeTypeLabel,
            integrationsMindsDBTypeLabel: localize.Integrations.mindsDBTypeLabel,
            integrationsMongoDBTypeLabel: localize.Integrations.mongoDBTypeLabel,
            integrationsMySQLTypeLabel: localize.Integrations.mySQLTypeLabel,
            integrationsDuckDBTypeLabel: localize.Integrations.duckDBTypeLabel,
            integrationsRedshiftTypeLabel: localize.Integrations.redshiftTypeLabel,
            integrationsSpannerTypeLabel: localize.Integrations.spannerTypeLabel,
            integrationsSQLServerTypeLabel: localize.Integrations.sqlServerTypeLabel,
            integrationsTrinoTypeLabel: localize.Integrations.trinoTypeLabel,
            integrationsCancel: localize.Integrations.cancel,
            integrationsSave: localize.Integrations.save,
            integrationsRequiredField: localize.Integrations.requiredField,
            integrationsOptionalField: localize.Integrations.optionalField,
            integrationsPostgresNameLabel: localize.Integrations.postgresNameLabel,
            integrationsPostgresNamePlaceholder: localize.Integrations.postgresNamePlaceholder,
            integrationsPostgresHostLabel: localize.Integrations.postgresHostLabel,
            integrationsPostgresHostPlaceholder: localize.Integrations.postgresHostPlaceholder,
            integrationsPostgresPortLabel: localize.Integrations.postgresPortLabel,
            integrationsPostgresPortPlaceholder: localize.Integrations.postgresPortPlaceholder,
            integrationsPostgresDatabaseLabel: localize.Integrations.postgresDatabaseLabel,
            integrationsPostgresDatabasePlaceholder: localize.Integrations.postgresDatabasePlaceholder,
            integrationsPostgresUsernameLabel: localize.Integrations.postgresUsernameLabel,
            integrationsPostgresUsernamePlaceholder: localize.Integrations.postgresUsernamePlaceholder,
            integrationsPostgresPasswordLabel: localize.Integrations.postgresPasswordLabel,
            integrationsPostgresPasswordPlaceholder: localize.Integrations.postgresPasswordPlaceholder,
            integrationsPostgresSslLabel: localize.Integrations.postgresSslLabel,
            integrationsBigQueryNameLabel: localize.Integrations.bigQueryNameLabel,
            integrationsBigQueryNamePlaceholder: localize.Integrations.bigQueryNamePlaceholder,
            integrationsBigQueryProjectIdLabel: localize.Integrations.bigQueryProjectIdLabel,
            integrationsBigQueryProjectIdPlaceholder: localize.Integrations.bigQueryProjectIdPlaceholder,
            integrationsBigQueryCredentialsLabel: localize.Integrations.bigQueryCredentialsLabel,
            integrationsBigQueryCredentialsPlaceholder: localize.Integrations.bigQueryCredentialsPlaceholder,
            integrationsBigQueryCredentialsRequired: localize.Integrations.bigQueryCredentialsRequired,
            integrationsBigQueryAuthMethodLabel: localize.Integrations.bigQueryAuthMethodLabel,
            integrationsBigQueryAuthMethodServiceAccount: localize.Integrations.bigQueryAuthMethodServiceAccount,
            integrationsBigQueryAuthMethodGoogleOauth: localize.Integrations.bigQueryAuthMethodGoogleOauth,
            integrationsBigQueryProjectLabel: localize.Integrations.bigQueryProjectLabel,
            integrationsBigQueryProjectPlaceholder: localize.Integrations.bigQueryProjectPlaceholder,
            integrationsBigQueryClientIdLabel: localize.Integrations.bigQueryClientIdLabel,
            integrationsBigQueryClientIdPlaceholder: localize.Integrations.bigQueryClientIdPlaceholder,
            integrationsBigQueryClientSecretLabel: localize.Integrations.bigQueryClientSecretLabel,
            integrationsBigQueryClientSecretPlaceholder: localize.Integrations.bigQueryClientSecretPlaceholder,
            integrationsAuthenticate: localize.Integrations.authenticate,
            integrationsReauthenticate: localize.Integrations.reauthenticate,
            integrationsTokenStatusAuthenticated: localize.Integrations.tokenStatusAuthenticated,
            integrationsTokenStatusDisconnected: localize.Integrations.tokenStatusDisconnected,
            integrationsAuthenticating: localize.Integrations.authenticating('{0}'),
            integrationsAuthenticationSucceeded: localize.Integrations.authenticationSucceeded('{0}'),
            integrationsAuthenticationFailed: localize.Integrations.authenticationFailed('{0}'),
            integrationsBigQueryNotAuthenticated: localize.Integrations.bigQueryNotAuthenticated('{0}'),
            integrationsFederatedAuthNotSupportedInWeb: localize.Integrations.federatedAuthNotSupportedInWeb,
            integrationsSnowflakeNameLabel: localize.Integrations.snowflakeNameLabel,
            integrationsSnowflakeNamePlaceholder: localize.Integrations.snowflakeNamePlaceholder,
            integrationsSnowflakeAccountLabel: localize.Integrations.snowflakeAccountLabel,
            integrationsSnowflakeAccountPlaceholder: localize.Integrations.snowflakeAccountPlaceholder,
            integrationsSnowflakeAuthMethodLabel: localize.Integrations.snowflakeAuthMethodLabel,
            integrationsSnowflakeAuthMethodSubLabel: localize.Integrations.snowflakeAuthMethodSubLabel,
            integrationsSnowflakeAuthMethodUsernamePassword: localize.Integrations.snowflakeAuthMethodUsernamePassword,
            integrationsSnowflakeAuthMethodKeyPair: localize.Integrations.snowflakeAuthMethodKeyPair,
            integrationsSnowflakeUnsupportedAuthMethod: localize.Integrations.snowflakeUnsupportedAuthMethod,
            integrationsSnowflakeUsernameLabel: localize.Integrations.snowflakeUsernameLabel,
            integrationsSnowflakePasswordLabel: localize.Integrations.snowflakePasswordLabel,
            integrationsSnowflakePasswordPlaceholder: localize.Integrations.snowflakePasswordPlaceholder,
            integrationsSnowflakeServiceAccountUsernameLabel:
                localize.Integrations.snowflakeServiceAccountUsernameLabel,
            integrationsSnowflakeServiceAccountUsernameHelp: localize.Integrations.snowflakeServiceAccountUsernameHelp,
            integrationsSnowflakePrivateKeyLabel: localize.Integrations.snowflakePrivateKeyLabel,
            integrationsSnowflakePrivateKeyHelp: localize.Integrations.snowflakePrivateKeyHelp,
            integrationsSnowflakePrivateKeyPlaceholder: localize.Integrations.snowflakePrivateKeyPlaceholder,
            integrationsSnowflakePrivateKeyPassphraseLabel: localize.Integrations.snowflakePrivateKeyPassphraseLabel,
            integrationsSnowflakePrivateKeyPassphraseHelp: localize.Integrations.snowflakePrivateKeyPassphraseHelp,
            integrationsSnowflakeDatabaseLabel: localize.Integrations.snowflakeDatabaseLabel,
            integrationsSnowflakeDatabasePlaceholder: localize.Integrations.snowflakeDatabasePlaceholder,
            integrationsSnowflakeRoleLabel: localize.Integrations.snowflakeRoleLabel,
            integrationsSnowflakeRolePlaceholder: localize.Integrations.snowflakeRolePlaceholder,
            integrationsSnowflakeWarehouseLabel: localize.Integrations.snowflakeWarehouseLabel,
            integrationsSnowflakeWarehousePlaceholder: localize.Integrations.snowflakeWarehousePlaceholder,
            integrationsMySQLNameLabel: localize.Integrations.mySQLNameLabel,
            integrationsMySQLNamePlaceholder: localize.Integrations.mySQLNamePlaceholder,
            integrationsMySQLHostLabel: localize.Integrations.mySQLHostLabel,
            integrationsMySQLHostPlaceholder: localize.Integrations.mySQLHostPlaceholder,
            integrationsMySQLPortLabel: localize.Integrations.mySQLPortLabel,
            integrationsMySQLDatabaseLabel: localize.Integrations.mySQLDatabaseLabel,
            integrationsMySQLDatabasePlaceholder: localize.Integrations.mySQLDatabasePlaceholder,
            integrationsMySQLUsernameLabel: localize.Integrations.mySQLUsernameLabel,
            integrationsMySQLUsernamePlaceholder: localize.Integrations.mySQLUsernamePlaceholder,
            integrationsMySQLPasswordLabel: localize.Integrations.mySQLPasswordLabel,
            integrationsMySQLPasswordPlaceholder: localize.Integrations.mySQLPasswordPlaceholder,
            integrationsMariaDBNameLabel: localize.Integrations.mariaDBNameLabel,
            integrationsMariaDBNamePlaceholder: localize.Integrations.mariaDBNamePlaceholder,
            integrationsMariaDBHostLabel: localize.Integrations.mariaDBHostLabel,
            integrationsMariaDBHostPlaceholder: localize.Integrations.mariaDBHostPlaceholder,
            integrationsMariaDBPortLabel: localize.Integrations.mariaDBPortLabel,
            integrationsMariaDBDatabaseLabel: localize.Integrations.mariaDBDatabaseLabel,
            integrationsMariaDBDatabasePlaceholder: localize.Integrations.mariaDBDatabasePlaceholder,
            integrationsMariaDBUsernameLabel: localize.Integrations.mariaDBUsernameLabel,
            integrationsMariaDBUsernamePlaceholder: localize.Integrations.mariaDBUsernamePlaceholder,
            integrationsMariaDBPasswordLabel: localize.Integrations.mariaDBPasswordLabel,
            integrationsMariaDBPasswordPlaceholder: localize.Integrations.mariaDBPasswordPlaceholder,
            integrationsAthenaNameLabel: localize.Integrations.athenaNameLabel,
            integrationsAthenaNamePlaceholder: localize.Integrations.athenaNamePlaceholder,
            integrationsAthenaAccessKeyIdLabel: localize.Integrations.athenaAccessKeyIdLabel,
            integrationsAthenaAccessKeyIdPlaceholder: localize.Integrations.athenaAccessKeyIdPlaceholder,
            integrationsAthenaSecretAccessKeyLabel: localize.Integrations.athenaSecretAccessKeyLabel,
            integrationsAthenaSecretAccessKeyPlaceholder: localize.Integrations.athenaSecretAccessKeyPlaceholder,
            integrationsAthenaRegionLabel: localize.Integrations.athenaRegionLabel,
            integrationsAthenaRegionPlaceholder: localize.Integrations.athenaRegionPlaceholder,
            integrationsAthenaS3OutputPathLabel: localize.Integrations.athenaS3OutputPathLabel,
            integrationsAthenaS3OutputPathPlaceholder: localize.Integrations.athenaS3OutputPathPlaceholder,
            integrationsAthenaWorkgroupLabel: localize.Integrations.athenaWorkgroupLabel,
            integrationsAthenaWorkgroupPlaceholder: localize.Integrations.athenaWorkgroupPlaceholder,
            integrationsDatabricksNameLabel: localize.Integrations.databricksNameLabel,
            integrationsDatabricksNamePlaceholder: localize.Integrations.databricksNamePlaceholder,
            integrationsDatabricksHostLabel: localize.Integrations.databricksHostLabel,
            integrationsDatabricksHostPlaceholder: localize.Integrations.databricksHostPlaceholder,
            integrationsDatabricksHttpPathLabel: localize.Integrations.databricksHttpPathLabel,
            integrationsDatabricksHttpPathPlaceholder: localize.Integrations.databricksHttpPathPlaceholder,
            integrationsDatabricksTokenLabel: localize.Integrations.databricksTokenLabel,
            integrationsDatabricksTokenPlaceholder: localize.Integrations.databricksTokenPlaceholder,
            integrationsDatabricksPortLabel: localize.Integrations.databricksPortLabel,
            integrationsDatabricksCatalogLabel: localize.Integrations.databricksCatalogLabel,
            integrationsDatabricksCatalogPlaceholder: localize.Integrations.databricksCatalogPlaceholder,
            integrationsDatabricksSchemaLabel: localize.Integrations.databricksSchemaLabel,
            integrationsDatabricksSchemaPlaceholder: localize.Integrations.databricksSchemaPlaceholder,
            integrationsDremioNameLabel: localize.Integrations.dremioNameLabel,
            integrationsDremioNamePlaceholder: localize.Integrations.dremioNamePlaceholder,
            integrationsDremioHostLabel: localize.Integrations.dremioHostLabel,
            integrationsDremioHostPlaceholder: localize.Integrations.dremioHostPlaceholder,
            integrationsDremioPortLabel: localize.Integrations.dremioPortLabel,
            integrationsDremioSchemaLabel: localize.Integrations.dremioSchemaLabel,
            integrationsDremioSchemaPlaceholder: localize.Integrations.dremioSchemaPlaceholder,
            integrationsDremioTokenLabel: localize.Integrations.dremioTokenLabel,
            integrationsDremioTokenPlaceholder: localize.Integrations.dremioTokenPlaceholder,
            integrationsMongoDBNameLabel: localize.Integrations.mongoDBNameLabel,
            integrationsMongoDBNamePlaceholder: localize.Integrations.mongoDBNamePlaceholder,
            integrationsMongoDBConnectionStringLabel: localize.Integrations.mongoDBConnectionStringLabel,
            integrationsMongoDBConnectionStringPlaceholder: localize.Integrations.mongoDBConnectionStringPlaceholder,
            integrationsMongoDBConnectionStringHelp: localize.Integrations.mongoDBConnectionStringHelp,
            integrationsMongoDBOptionalFieldsNote: localize.Integrations.mongoDBOptionalFieldsNote,
            integrationsMongoDBRawConnectionStringLabel: localize.Integrations.mongoDBRawConnectionStringLabel,
            integrationsMongoDBPrefixLabel: localize.Integrations.mongoDBPrefixLabel,
            integrationsMongoDBHostLabel: localize.Integrations.mongoDBHostLabel,
            integrationsMongoDBPortLabel: localize.Integrations.mongoDBPortLabel,
            integrationsMongoDBUserLabel: localize.Integrations.mongoDBUserLabel,
            integrationsMongoDBPasswordLabel: localize.Integrations.mongoDBPasswordLabel,
            integrationsMongoDBDatabaseLabel: localize.Integrations.mongoDBDatabaseLabel,
            integrationsMongoDBOptionsLabel: localize.Integrations.mongoDBOptionsLabel,
            integrationsRedshiftNameLabel: localize.Integrations.redshiftNameLabel,
            integrationsRedshiftNamePlaceholder: localize.Integrations.redshiftNamePlaceholder,
            integrationsRedshiftAuthMethodLabel: localize.Integrations.redshiftAuthMethodLabel,
            integrationsRedshiftAuthMethodUsernamePassword: localize.Integrations.redshiftAuthMethodUsernamePassword,
            integrationsRedshiftAuthMethodIndividualCredentials:
                localize.Integrations.redshiftAuthMethodIndividualCredentials,
            integrationsRedshiftAuthMethodHelp: localize.Integrations.redshiftAuthMethodHelp,
            integrationsRedshiftHostLabel: localize.Integrations.redshiftHostLabel,
            integrationsRedshiftHostPlaceholder: localize.Integrations.redshiftHostPlaceholder,
            integrationsRedshiftPortLabel: localize.Integrations.redshiftPortLabel,
            integrationsRedshiftDatabaseLabel: localize.Integrations.redshiftDatabaseLabel,
            integrationsRedshiftDatabasePlaceholder: localize.Integrations.redshiftDatabasePlaceholder,
            integrationsRedshiftUsernameLabel: localize.Integrations.redshiftUsernameLabel,
            integrationsRedshiftUsernamePlaceholder: localize.Integrations.redshiftUsernamePlaceholder,
            integrationsRedshiftPasswordLabel: localize.Integrations.redshiftPasswordLabel,
            integrationsRedshiftPasswordPlaceholder: localize.Integrations.redshiftPasswordPlaceholder,
            integrationsSpannerNameLabel: localize.Integrations.spannerNameLabel,
            integrationsSpannerNamePlaceholder: localize.Integrations.spannerNamePlaceholder,
            integrationsSpannerInstanceLabel: localize.Integrations.spannerInstanceLabel,
            integrationsSpannerInstancePlaceholder: localize.Integrations.spannerInstancePlaceholder,
            integrationsSpannerDatabaseLabel: localize.Integrations.spannerDatabaseLabel,
            integrationsSpannerDatabasePlaceholder: localize.Integrations.spannerDatabasePlaceholder,
            integrationsSpannerServiceAccountLabel: localize.Integrations.spannerServiceAccountLabel,
            integrationsSpannerServiceAccountPlaceholder: localize.Integrations.spannerServiceAccountPlaceholder,
            integrationsSpannerServiceAccountHelp: localize.Integrations.spannerServiceAccountHelp,
            integrationsSpannerServiceAccountInvalidJson: localize.Integrations.spannerServiceAccountInvalidJson,
            integrationsSpannerServiceAccountRequired: localize.Integrations.spannerServiceAccountRequired,
            integrationsSpannerDataBoostLabel: localize.Integrations.spannerDataBoostLabel,
            integrationsSpannerDataBoostHelp: localize.Integrations.spannerDataBoostHelp,
            integrationsCloudSqlNameLabel: localize.Integrations.cloudSqlNameLabel,
            integrationsCloudSqlNamePlaceholder: localize.Integrations.cloudSqlNamePlaceholder,
            integrationsCloudSqlServiceAccountLabel: localize.Integrations.cloudSqlServiceAccountLabel,
            integrationsCloudSqlServiceAccountPlaceholder: localize.Integrations.cloudSqlServiceAccountPlaceholder,
            integrationsCloudSqlServiceAccountHelp: localize.Integrations.cloudSqlServiceAccountHelp,
            integrationsCloudSqlServiceAccountInvalidJson: localize.Integrations.cloudSqlServiceAccountInvalidJson,
            integrationsCloudSqlServiceAccountRequired: localize.Integrations.cloudSqlServiceAccountRequired,
            integrationsAlloyDBNameLabel: localize.Integrations.alloyDBNameLabel,
            integrationsAlloyDBNamePlaceholder: localize.Integrations.alloyDBNamePlaceholder,
            integrationsAlloyDBHostLabel: localize.Integrations.alloyDBHostLabel,
            integrationsAlloyDBHostPlaceholder: localize.Integrations.alloyDBHostPlaceholder,
            integrationsAlloyDBPortLabel: localize.Integrations.alloyDBPortLabel,
            integrationsAlloyDBDatabaseLabel: localize.Integrations.alloyDBDatabaseLabel,
            integrationsAlloyDBDatabasePlaceholder: localize.Integrations.alloyDBDatabasePlaceholder,
            integrationsAlloyDBUsernameLabel: localize.Integrations.alloyDBUsernameLabel,
            integrationsAlloyDBUsernamePlaceholder: localize.Integrations.alloyDBUsernamePlaceholder,
            integrationsAlloyDBPasswordLabel: localize.Integrations.alloyDBPasswordLabel,
            integrationsAlloyDBPasswordPlaceholder: localize.Integrations.alloyDBPasswordPlaceholder,
            integrationsClickHouseNameLabel: localize.Integrations.clickHouseNameLabel,
            integrationsClickHouseNamePlaceholder: localize.Integrations.clickHouseNamePlaceholder,
            integrationsClickHouseHostLabel: localize.Integrations.clickHouseHostLabel,
            integrationsClickHouseHostPlaceholder: localize.Integrations.clickHouseHostPlaceholder,
            integrationsClickHousePortLabel: localize.Integrations.clickHousePortLabel,
            integrationsClickHouseDatabaseLabel: localize.Integrations.clickHouseDatabaseLabel,
            integrationsClickHouseDatabasePlaceholder: localize.Integrations.clickHouseDatabasePlaceholder,
            integrationsClickHouseUsernameLabel: localize.Integrations.clickHouseUsernameLabel,
            integrationsClickHouseUsernamePlaceholder: localize.Integrations.clickHouseUsernamePlaceholder,
            integrationsClickHousePasswordLabel: localize.Integrations.clickHousePasswordLabel,
            integrationsClickHousePasswordPlaceholder: localize.Integrations.clickHousePasswordPlaceholder,
            integrationsMaterializeNameLabel: localize.Integrations.materializeNameLabel,
            integrationsMaterializeNamePlaceholder: localize.Integrations.materializeNamePlaceholder,
            integrationsMaterializeHostLabel: localize.Integrations.materializeHostLabel,
            integrationsMaterializeHostPlaceholder: localize.Integrations.materializeHostPlaceholder,
            integrationsMaterializePortLabel: localize.Integrations.materializePortLabel,
            integrationsMaterializeDatabaseLabel: localize.Integrations.materializeDatabaseLabel,
            integrationsMaterializeDatabasePlaceholder: localize.Integrations.materializeDatabasePlaceholder,
            integrationsMaterializeClusterLabel: localize.Integrations.materializeClusterLabel,
            integrationsMaterializeClusterPlaceholder: localize.Integrations.materializeClusterPlaceholder,
            integrationsMaterializeUsernameLabel: localize.Integrations.materializeUsernameLabel,
            integrationsMaterializeUsernamePlaceholder: localize.Integrations.materializeUsernamePlaceholder,
            integrationsMaterializePasswordLabel: localize.Integrations.materializePasswordLabel,
            integrationsMaterializePasswordPlaceholder: localize.Integrations.materializePasswordPlaceholder,
            integrationsMindsDBNameLabel: localize.Integrations.mindsDBNameLabel,
            integrationsMindsDBNamePlaceholder: localize.Integrations.mindsDBNamePlaceholder,
            integrationsMindsDBHostLabel: localize.Integrations.mindsDBHostLabel,
            integrationsMindsDBHostPlaceholder: localize.Integrations.mindsDBHostPlaceholder,
            integrationsMindsDBPortLabel: localize.Integrations.mindsDBPortLabel,
            integrationsMindsDBDatabaseLabel: localize.Integrations.mindsDBDatabaseLabel,
            integrationsMindsDBDatabasePlaceholder: localize.Integrations.mindsDBDatabasePlaceholder,
            integrationsMindsDBUsernameLabel: localize.Integrations.mindsDBUsernameLabel,
            integrationsMindsDBUsernamePlaceholder: localize.Integrations.mindsDBUsernamePlaceholder,
            integrationsMindsDBPasswordLabel: localize.Integrations.mindsDBPasswordLabel,
            integrationsMindsDBPasswordPlaceholder: localize.Integrations.mindsDBPasswordPlaceholder,
            integrationsSQLServerNameLabel: localize.Integrations.sqlServerNameLabel,
            integrationsSQLServerNamePlaceholder: localize.Integrations.sqlServerNamePlaceholder,
            integrationsSQLServerHostLabel: localize.Integrations.sqlServerHostLabel,
            integrationsSQLServerHostPlaceholder: localize.Integrations.sqlServerHostPlaceholder,
            integrationsSQLServerPortLabel: localize.Integrations.sqlServerPortLabel,
            integrationsSQLServerDatabaseLabel: localize.Integrations.sqlServerDatabaseLabel,
            integrationsSQLServerDatabasePlaceholder: localize.Integrations.sqlServerDatabasePlaceholder,
            integrationsSQLServerUsernameLabel: localize.Integrations.sqlServerUsernameLabel,
            integrationsSQLServerUsernamePlaceholder: localize.Integrations.sqlServerUsernamePlaceholder,
            integrationsSQLServerPasswordLabel: localize.Integrations.sqlServerPasswordLabel,
            integrationsSQLServerPasswordPlaceholder: localize.Integrations.sqlServerPasswordPlaceholder,
            integrationsTrinoNameLabel: localize.Integrations.trinoNameLabel,
            integrationsTrinoNamePlaceholder: localize.Integrations.trinoNamePlaceholder,
            integrationsTrinoHostLabel: localize.Integrations.trinoHostLabel,
            integrationsTrinoHostPlaceholder: localize.Integrations.trinoHostPlaceholder,
            integrationsTrinoPortLabel: localize.Integrations.trinoPortLabel,
            integrationsTrinoDatabaseLabel: localize.Integrations.trinoDatabaseLabel,
            integrationsTrinoDatabasePlaceholder: localize.Integrations.trinoDatabasePlaceholder,
            integrationsTrinoUsernameLabel: localize.Integrations.trinoUsernameLabel,
            integrationsTrinoUsernamePlaceholder: localize.Integrations.trinoUsernamePlaceholder,
            integrationsTrinoPasswordLabel: localize.Integrations.trinoPasswordLabel,
            integrationsTrinoPasswordPlaceholder: localize.Integrations.trinoPasswordPlaceholder,
            integrationsSshEnabled: localize.Integrations.sshEnabled,
            integrationsSshHost: localize.Integrations.sshHost,
            integrationsSshHostPlaceholder: localize.Integrations.sshHostPlaceholder,
            integrationsSshPort: localize.Integrations.sshPort,
            integrationsSshUser: localize.Integrations.sshUser,
            integrationsSshUserPlaceholder: localize.Integrations.sshUserPlaceholder,
            integrationsSslEnabled: localize.Integrations.sslEnabled,
            integrationsCaCertificateName: localize.Integrations.caCertificateName,
            integrationsCaCertificateNamePlaceholder: localize.Integrations.caCertificateNamePlaceholder,
            integrationsCaCertificateText: localize.Integrations.caCertificateText,
            integrationsCaCertificateTextPlaceholder: localize.Integrations.caCertificateTextPlaceholder,
            integrationsUnnamedIntegration: localize.Integrations.unnamedIntegration('{0}'),
            integrationsDefaultName: localize.Integrations.defaultName('{0}'),
            integrationsUnsupportedIntegrationType: localize.Integrations.unsupportedIntegrationType('{0}')
        };

        await this.currentPanel.webview.postMessage({
            type: SharedMessages.LocInit,
            locStrings: locStrings
        });
    }

    /** Update the webview with current integration data. Each call gets a generation number; stale or post-dispose updates bail at every await. */
    private async updateWebview(): Promise<void> {
        if (!this.currentPanel) {
            logger.debug('IntegrationWebviewProvider: No current panel, skipping update');
            return;
        }

        // Bumped before any await so the newest call always owns the highest generation; every earlier call
        // then loses the comparison below no matter which of them resumes last.
        this.updateGeneration += 1;
        const generation = this.updateGeneration;

        const [candidates, fileConfiguredIds, fingerprints] = await Promise.all([
            this.resolveFederatedAuthCandidates(),
            this.resolveFileConfiguredIds(),
            this.resolveFederatedAuthFingerprints()
        ]);

        const integrationsData = await Promise.all(
            Array.from(this.integrations.entries()).map(async ([id, integration]) => ({
                // SecretStorage only: the webview learns *that* an integration is file-configured, never the
                // file's config or credentials.
                config: integration.config,
                id,
                integrationName: integration.integrationName,
                integrationType: integration.integrationType,
                isFileConfigured: fileConfiguredIds.has(id),
                tokenStatus: candidates.has(id) ? await this.deriveTokenStatus(id, fingerprints.get(id)) : 'unsupported'
            }))
        );

        // Bail if the panel was disposed during the candidate/file-configured lookups or the `tokenStorage.has()` await.
        if (!this.currentPanel) {
            logger.debug('IntegrationWebviewProvider: Panel disposed during update, skipping postMessage');
            return;
        }

        // A newer update started; let it post the fresher state.
        if (generation !== this.updateGeneration) {
            logger.debug(
                `IntegrationWebviewProvider: Superseded by newer update (gen ${generation} < ${this.updateGeneration}), skipping postMessage`
            );
            return;
        }

        logger.debug(`IntegrationWebviewProvider: Sending ${integrationsData.length} integrations to webview`);

        await this.currentPanel.webview.postMessage({
            integrations: integrationsData,
            projectName: this.projectName,
            type: 'update'
        });
    }

    /** Drops stale federated tokens when the new config's fingerprint changed or the auth method is no longer `google-oauth`. */
    private async invalidateStaleFederatedToken(
        integrationId: string,
        newConfig: ConfigurableDatabaseIntegrationConfig
    ): Promise<void> {
        if (!this.tokenStorage) {
            return;
        }

        const stored = await this.tokenStorage.get(integrationId);
        if (!stored) {
            return;
        }

        // Switched away from google-oauth (or another integration type): previously-captured token is meaningless.
        if (newConfig.type !== 'big-query' || newConfig.metadata.authMethod !== BigQueryAuthMethods.GoogleOauth) {
            logger.info(
                `IntegrationWebviewProvider: deleting stale federated token for ${integrationId} (auth method changed).`
            );
            await this.tokenStorage.delete(integrationId);
            return;
        }

        // Same auth method but OAuth client metadata changed: stored token was issued against a different client.
        const { clientId, clientSecret, project } = newConfig.metadata;
        const newFingerprint = this.tokenStorage.computeMetadataFingerprint({ clientId, clientSecret, project });
        if (newFingerprint !== stored.metadataFingerprint) {
            logger.info(
                `IntegrationWebviewProvider: deleting stale federated token for ${integrationId} (fingerprint changed).`
            );
            await this.tokenStorage.delete(integrationId);
        }
    }

    /**
     * Ids eligible for federated auth in the active notebook — derived state only, so no `.deepnote.env.yaml`
     * credentials enter the panel. A failed lookup degrades to "none eligible" rather than blocking the render.
     */
    /**
     * OAuth metadata fingerprints for the active notebook's merged configs, so a token minted against a client the
     * user has since edited in `.deepnote.env.yaml` stops reading as authenticated. Empty on failure, which
     * `deriveTokenStatus` treats as "cannot tell" rather than "stale".
     */
    private async resolveFederatedAuthFingerprints(): Promise<ReadonlyMap<string, string>> {
        const fingerprints = new Map<string, string>();
        if (!this.activeFileUri || !this.tokenStorage) {
            return fingerprints;
        }

        try {
            const configs = await this.sqlIntegrationEnvVars.getMergedIntegrationConfigs(this.activeFileUri);
            for (const config of configs) {
                const metadata = config.metadata;
                // google-oauth is the only federated method carrying an OAuth client to fingerprint.
                if (!isFederatedAuthMetadata(metadata) || metadata.authMethod !== BigQueryAuthMethods.GoogleOauth) {
                    continue;
                }

                const { clientId, clientSecret, project } = metadata;
                fingerprints.set(
                    config.id,
                    this.tokenStorage.computeMetadataFingerprint({ clientId, clientSecret, project })
                );
            }
        } catch (err) {
            logger.warn('IntegrationWebviewProvider: failed to resolve federated auth fingerprints.', err);
        }

        return fingerprints;
    }

    private async resolveFederatedAuthCandidates(): Promise<ReadonlySet<string>> {
        if (!this.activeFileUri) {
            return new Set<string>();
        }

        try {
            return await this.sqlIntegrationEnvVars.getFederatedAuthCandidates(this.activeFileUri);
        } catch (err) {
            logger.warn('IntegrationWebviewProvider: failed to resolve federated auth candidates.', err);

            return new Set<string>();
        }
    }

    /**
     * Ids `.deepnote.env.yaml` configures for the active notebook — ids only, so the panel can mark those rows
     * read-only without ever holding file config. A failed lookup degrades to "none" rather than blocking the render.
     */
    private async resolveFileConfiguredIds(): Promise<ReadonlySet<string>> {
        if (!this.activeFileUri) {
            return new Set<string>();
        }

        try {
            return await this.sqlIntegrationEnvVars.getFileConfiguredIntegrationIds(this.activeFileUri);
        } catch (err) {
            logger.warn('IntegrationWebviewProvider: failed to resolve file-configured integration ids.', err);

            return new Set<string>();
        }
    }

    /**
     * Refuses an edit to an integration `.deepnote.env.yaml` owns, and says so; returns `true` when it did.
     * The panel writes SecretStorage, which the file-wins merge overrides, so going through with the edit would
     * report success and change nothing at runtime. Each mutating action calls this itself rather than trusting
     * the webview to have hidden its button — `showConfigurationForm` is reachable from the SQL status bar too.
     *
     * Re-resolves the file per action instead of reading what the last render saw, so it cannot be defeated by a
     * stale snapshot, a lost `updateWebview()` generation race, or a switch to another notebook. That costs one
     * extra `.deepnote.env.yaml` read per user-initiated edit (two on the `show(selectedIntegrationId)` path, which
     * refreshes first) — rare and off the render path, so it is worth paying for a guard that cannot go stale.
     * A read failure fails open: a hiccup must not block a real edit.
     */
    private async refuseEditIfFileConfigured(integrationId: string): Promise<boolean> {
        const fileConfiguredIds = await this.resolveFileConfiguredIds();
        if (!fileConfiguredIds.has(integrationId)) {
            return false;
        }

        const name = this.integrations.get(integrationId)?.integrationName || integrationId;

        logger.debug(
            `IntegrationWebviewProvider: Refused edit of ${integrationId}; it is configured in .deepnote.env.yaml`
        );
        void window.showInformationMessage(
            l10n.t(
                "'{0}' is configured in .deepnote.env.yaml, which takes precedence over anything saved here. Edit that file to change it.",
                name
            )
        );

        return true;
    }

    /**
     * Whether a federated-auth-eligible integration currently holds a token issued against its *current* OAuth
     * client. Eligibility is the caller's call. An undefined `expectedFingerprint` means the config could not be
     * read, so existence alone decides rather than pushing the user into a needless re-auth.
     */
    private async deriveTokenStatus(
        integrationId: string,
        expectedFingerprint: string | undefined
    ): Promise<FederatedAuthTokenStatus> {
        if (!this.tokenStorage) {
            return 'unsupported';
        }

        try {
            const entry = await this.tokenStorage.get(integrationId);
            if (!entry) {
                return 'disconnected';
            }

            return expectedFingerprint === undefined || entry.metadataFingerprint === expectedFingerprint
                ? 'authenticated'
                : 'disconnected';
        } catch (err) {
            logger.warn(
                `IntegrationWebviewProvider: failed to check token for ${integrationId}; reporting disconnected.`,
                err
            );

            return 'disconnected';
        }
    }

    private trackIntegrationEvent(event: {
        eventName: 'configure_integration' | 'delete_integration' | 'reset_integration';
        integrationType: string | undefined;
    }): void {
        const properties = { integrationType: event.integrationType ?? 'unknown' };

        this.analytics.trackEvent({ eventName: event.eventName, properties });
    }

    /** Handle messages from the webview; mirrors the `WebviewOutboundMessage` union in `src/webviews/webview-side/integrations/types.ts`. */
    private async handleMessage(message: {
        type: string;
        integrationId?: string;
        config?: ConfigurableDatabaseIntegrationConfig;
    }): Promise<void> {
        switch (message.type) {
            case 'configure':
                if (message.integrationId) {
                    await this.showConfigurationForm(message.integrationId);
                }
                break;
            case 'save':
                if (message.integrationId && message.config) {
                    const saved = await this.saveConfiguration(message.integrationId, message.config);

                    if (saved) {
                        // Legacy big-query configs may omit authMethod, which means service-account.
                        const authMethod =
                            message.config.type === 'big-query'
                                ? message.config.metadata.authMethod ?? BigQueryAuthMethods.ServiceAccount
                                : undefined;

                        this.analytics.trackEvent({
                            eventName: 'save_integration',
                            properties: {
                                integrationType: message.config.type,
                                ...(authMethod ? { authMethod } : {})
                            }
                        });
                    }
                }
                break;
            case 'reset':
                if (message.integrationId) {
                    const integrationType = this.integrations.get(message.integrationId)?.integrationType;
                    const reset = await this.resetConfiguration(message.integrationId);

                    if (reset) {
                        this.trackIntegrationEvent({ eventName: 'reset_integration', integrationType });
                    }
                }
                break;
            case 'delete':
                if (message.integrationId) {
                    const integrationType = this.integrations.get(message.integrationId)?.integrationType;
                    const deleted = await this.deleteConfiguration(message.integrationId);

                    if (deleted) {
                        this.trackIntegrationEvent({ eventName: 'delete_integration', integrationType });
                    }
                }
                break;
            case 'signOut':
                if (message.integrationId) {
                    await this.signOutIntegration(message.integrationId);
                }
                break;
            case 'authenticate':
                if (message.integrationId) {
                    const integrationType = this.integrations.get(message.integrationId)?.integrationType;
                    let outcome: CommandOutcome = 'failed';

                    try {
                        // Same URI the candidate set was derived from, so the button's eligibility and the
                        // command's config lookup cannot disagree about which notebook they mean.
                        outcome =
                            (await commands.executeCommand<CommandOutcome | undefined>(
                                Commands.AuthenticateIntegration,
                                message.integrationId,
                                this.activeFileUri
                            )) ?? 'failed';
                    } catch (error) {
                        // Command handler shows its own toasts; log here to avoid an unhandled-rejection.
                        logger.error(
                            `IntegrationWebviewProvider: AuthenticateIntegration command failed for ${message.integrationId}`,
                            error
                        );
                    }

                    this.analytics.trackEvent({
                        eventName: 'authenticate_integration',
                        properties: { integrationType: integrationType ?? 'unknown', outcome }
                    });
                }
                break;
        }
    }

    /**
     * Tracked here rather than in the webview `configure` handler so the SQL status bar's
     * "Configure current integration", which opens the form directly via `show()`, is counted too.
     */
    private async showConfigurationForm(integrationId: string): Promise<void> {
        const integration = this.integrations.get(integrationId);
        if (!integration) {
            return;
        }

        if (await this.refuseEditIfFileConfigured(integrationId)) {
            return;
        }

        await this.currentPanel?.webview.postMessage({
            config: integration.config,
            integrationId,
            integrationName: integration.integrationName,
            integrationType: integration.integrationType,
            type: 'showForm'
        });

        this.trackIntegrationEvent({
            eventName: 'configure_integration',
            integrationType: integration.integrationType
        });
    }

    /**
     * Save the configuration for an integration
     */
    private async saveConfiguration(
        integrationId: string,
        config: ConfigurableDatabaseIntegrationConfig
    ): Promise<boolean> {
        if (await this.refuseEditIfFileConfigured(integrationId)) {
            return false;
        }

        try {
            // Invalidate stale federated tokens before saving (fingerprint change or auth-method switch).
            await this.invalidateStaleFederatedToken(integrationId, config);

            await this.integrationStorage.save(config);

            // Update local state
            const integration = this.integrations.get(integrationId);
            if (integration) {
                // Existing integration - update it
                integration.config = config;
                integration.integrationName = config.name;
                integration.integrationType = config.type;
                this.integrations.set(integrationId, integration);
            } else {
                // New integration - add it to the map
                this.integrations.set(integrationId, {
                    config,
                    integrationName: config.name,
                    integrationType: config.type
                });
            }

            const persisted = await this.updateProjectIntegrationsList();

            await this.updateWebview();

            if (persisted) {
                await this.currentPanel?.webview.postMessage({
                    message: l10n.t('Configuration saved successfully'),
                    type: 'success'
                });
            }

            // The credential save above is the tracked operation; a skipped project-YAML sync is not a failure.
            return true;
        } catch (error) {
            logger.error('Failed to save integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to save configuration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });

            return false;
        }
    }

    /**
     * Reset the configuration for an integration (clears credentials but keeps the integration entry)
     */
    /**
     * Clears only the federated token. Unlike reset/delete this is permitted for a file-configured integration:
     * `refuseEditIfFileConfigured` exists because the panel writes SecretStorage and `.deepnote.env.yaml` wins the
     * merge, and the token store has no file layer to be overridden by. Without this there is no supported way to
     * drop a refresh token for an integration declared in the file.
     */
    private async signOutIntegration(integrationId: string): Promise<void> {
        try {
            // `delete` fires onDidChangeTokens, which re-renders the panel; no explicit updateWebview needed.
            await this.tokenStorage?.delete(integrationId);
        } catch (error) {
            logger.error('Failed to sign out integration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t('Failed to sign out: {0}', error instanceof Error ? error.message : 'Unknown error'),
                type: 'error'
            });
        }
    }

    private async resetConfiguration(integrationId: string): Promise<boolean> {
        if (await this.refuseEditIfFileConfigured(integrationId)) {
            return false;
        }

        try {
            // Token first: a failure here has to abort before the config is committed, otherwise the token is
            // stranded with no integration left in the panel to retry from.
            await this.tokenStorage?.delete(integrationId);
            await this.integrationStorage.delete(integrationId);

            // Update local state
            const integration = this.integrations.get(integrationId);
            if (integration) {
                integration.config = null;
                this.integrations.set(integrationId, integration);
            }

            const persisted = await this.updateProjectIntegrationsList();

            await this.updateWebview();

            if (persisted) {
                await this.currentPanel?.webview.postMessage({
                    message: l10n.t('Configuration reset successfully'),
                    type: 'success'
                });
            }

            // The credential reset above is the tracked operation; a skipped project-YAML sync is not a failure.
            return true;
        } catch (error) {
            logger.error('Failed to reset integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to reset configuration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });

            return false;
        }
    }

    /**
     * Delete the integration completely (removes credentials and integration entry)
     */
    private async deleteConfiguration(integrationId: string): Promise<boolean> {
        if (await this.refuseEditIfFileConfigured(integrationId)) {
            return false;
        }

        try {
            // Token first: a failure here has to abort before the config is committed, otherwise the token is
            // stranded with no integration left in the panel to retry from.
            await this.tokenStorage?.delete(integrationId);
            await this.integrationStorage.delete(integrationId);

            // Remove from local state
            this.integrations.delete(integrationId);

            const persisted = await this.updateProjectIntegrationsList();

            await this.updateWebview();

            if (persisted) {
                await this.currentPanel?.webview.postMessage({
                    message: l10n.t('Integration deleted successfully'),
                    type: 'success'
                });
            }

            // The credential delete above is the tracked operation; a skipped project-YAML sync is not a failure.
            return true;
        } catch (error) {
            logger.error('Failed to delete integration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to delete integration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });

            return false;
        }
    }

    /**
     * Update the project's integrations list based on current integrations
     */
    private async updateProjectIntegrationsList(): Promise<boolean> {
        if (!this.projectId || !this.activeFileUri) {
            logger.warn('IntegrationWebviewProvider: No project ID / active file available, skipping project update');
            return false;
        }

        // Build the integrations list from current integrations
        const projectIntegrations: ProjectIntegration[] = Array.from(this.integrations.entries())
            .map(([id, integration]): ProjectIntegration | null => {
                // Get the integration type from config or integration metadata
                const type = integration.config?.type || integration.integrationType;
                if (!type) {
                    logger.warn(`IntegrationWebviewProvider: No type found for integration ${id}, skipping`);
                    return null;
                }

                return {
                    id,
                    name: integration.config?.name || integration.integrationName || id,
                    type
                };
            })
            .filter((integration): integration is ProjectIntegration => integration !== null);

        logger.debug(
            `IntegrationWebviewProvider: Updating project ${this.projectId} with ${projectIntegrations.length} integrations`
        );

        const { activePersisted, siblingsFailed } = await persistProjectIntegrations({
            notebookManager: this.notebookManager,
            projectId: this.projectId,
            integrations: projectIntegrations,
            activeFileUri: this.activeFileUri
        });

        if (!activePersisted) {
            logger.error(
                `IntegrationWebviewProvider: Failed to persist integrations for project ${this.projectId} to disk`
            );
            void window.showErrorMessage(l10n.t('Failed to save integrations to the notebook file. Please try again.'));

            return false;
        }

        if (siblingsFailed > 0) {
            void window.showWarningMessage(
                l10n.t('Integrations saved, but {0} related notebook file(s) could not be updated.', siblingsFailed)
            );
        }

        return true;
    }

    /**
     * Get the HTML content for the webview (React-based)
     */
    private getWebviewContent(): string {
        if (!this.currentPanel) {
            return '';
        }

        const webview = this.currentPanel.webview;
        const nonce = this.getNonce();

        // Get URIs for the React app
        const scriptUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'integrations',
                'index.js'
            )
        );
        const codiconUri = webview.asWebviewUri(
            Uri.joinPath(
                this.extensionContext.extensionUri,
                'dist',
                'webviews',
                'webview-side',
                'react-common',
                'codicon',
                'codicon.css'
            )
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link rel="stylesheet" href="${codiconUri}">
    <title>Deepnote Integrations</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
