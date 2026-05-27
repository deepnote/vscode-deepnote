import { inject, injectable, optional } from 'inversify';
import { commands, Disposable, l10n, Uri, ViewColumn, WebviewPanel, window } from 'vscode';

import { BigQueryAuthMethods } from '@deepnote/database-integrations';

import { Commands } from '../../../platform/common/constants';
import { IDisposableRegistry, IExtensionContext } from '../../../platform/common/types';
import * as localize from '../../../platform/common/utils/localize';
import { logger } from '../../../platform/logging';
import { LocalizedMessages, SharedMessages } from '../../../messageTypes';
import { IDeepnoteNotebookManager, ProjectIntegration } from '../../types';
import { IFederatedAuthTokenStorage, IIntegrationStorage, IIntegrationWebviewProvider } from './types';
import {
    ConfigurableDatabaseIntegrationConfig,
    FederatedAuthTokenStatus,
    IntegrationStatus,
    IntegrationWithStatus
} from '../../../platform/notebooks/deepnote/integrationTypes';

/**
 * Manages the webview panel for integration configuration
 */
@injectable()
export class IntegrationWebviewProvider implements IIntegrationWebviewProvider {
    private currentPanel: WebviewPanel | undefined;

    private readonly disposables: Disposable[] = [];

    private integrations: Map<string, IntegrationWithStatus> = new Map();

    private projectId: string | undefined;

    /** Generation counter for `updateWebview()` ("latest call wins"; stale in-flight updates bail). */
    private updateGeneration = 0;

    constructor(
        @inject(IExtensionContext) private readonly extensionContext: IExtensionContext,
        @inject(IIntegrationStorage) private readonly integrationStorage: IIntegrationStorage,
        @inject(IDeepnoteNotebookManager) private readonly notebookManager: IDeepnoteNotebookManager,
        @inject(IDisposableRegistry) private readonly disposableRegistry: IDisposableRegistry,
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
     * @param selectedIntegrationId Optional integration ID to select/configure immediately
     */
    public async show(
        projectId: string,
        integrations: Map<string, IntegrationWithStatus>,
        selectedIntegrationId?: string
    ): Promise<void> {
        // Update the stored integrations and project ID with the latest data
        this.projectId = projectId;
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
            integrationsNotConfigured: localize.Integrations.notConfigured,
            integrationsConfigure: localize.Integrations.configure,
            integrationsReconfigure: localize.Integrations.reconfigure,
            integrationsReset: localize.Integrations.reset,
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
            // BigQuery federated-auth form strings (M4)
            integrationsBigQueryAuthMethodLabel: localize.Integrations.bigQueryAuthMethodLabel,
            integrationsBigQueryAuthMethodServiceAccount: localize.Integrations.bigQueryAuthMethodServiceAccount,
            integrationsBigQueryAuthMethodGoogleOauth: localize.Integrations.bigQueryAuthMethodGoogleOauth,
            integrationsBigQueryProjectLabel: localize.Integrations.bigQueryProjectLabel,
            integrationsBigQueryProjectPlaceholder: localize.Integrations.bigQueryProjectPlaceholder,
            integrationsBigQueryClientIdLabel: localize.Integrations.bigQueryClientIdLabel,
            integrationsBigQueryClientIdPlaceholder: localize.Integrations.bigQueryClientIdPlaceholder,
            integrationsBigQueryClientSecretLabel: localize.Integrations.bigQueryClientSecretLabel,
            integrationsBigQueryClientSecretPlaceholder: localize.Integrations.bigQueryClientSecretPlaceholder,
            // Federated-auth integration management strings (M4)
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
            integrationsSpannerDataBoostLabel: localize.Integrations.spannerDataBoostLabel,
            integrationsSpannerDataBoostHelp: localize.Integrations.spannerDataBoostHelp,
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

        this.updateGeneration += 1;
        const generation = this.updateGeneration;

        const integrationsData = await Promise.all(
            Array.from(this.integrations.entries()).map(async ([id, integration]) => ({
                config: integration.config,
                id,
                integrationName: integration.integrationName,
                integrationType: integration.integrationType,
                status: integration.status,
                tokenStatus: await this.deriveTokenStatus(id, integration.config)
            }))
        );

        // Bail if the panel was disposed during the `tokenStorage.has()` await.
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

        // Get the project name from the notebook manager
        let projectName: string | undefined;
        if (this.projectId) {
            const project = this.notebookManager.getOriginalProject(this.projectId);
            projectName = project?.project.name;
        }

        await this.currentPanel.webview.postMessage({
            integrations: integrationsData,
            projectName,
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
            await this.tokenStorage.delete(integrationId).catch((err) => {
                logger.warn(
                    `IntegrationWebviewProvider: failed to delete stale federated token for ${integrationId}`,
                    err
                );
            });
            return;
        }

        // Same auth method but OAuth client metadata changed: stored token was issued against a different client.
        const { clientId, clientSecret, project } = newConfig.metadata;
        const newFingerprint = this.tokenStorage.computeMetadataFingerprint({ clientId, clientSecret, project });
        if (newFingerprint !== stored.metadataFingerprint) {
            logger.info(
                `IntegrationWebviewProvider: deleting stale federated token for ${integrationId} (fingerprint changed).`
            );
            await this.tokenStorage.delete(integrationId).catch((err) => {
                logger.warn(
                    `IntegrationWebviewProvider: failed to delete stale federated token for ${integrationId}`,
                    err
                );
            });
        }
    }

    /** Federated-auth token status: `'unsupported'` for non-BigQuery, non-google-oauth, or web; else `'authenticated'`/`'disconnected'`. */
    private async deriveTokenStatus(
        integrationId: string,
        config: ConfigurableDatabaseIntegrationConfig | null
    ): Promise<FederatedAuthTokenStatus> {
        if (!this.tokenStorage) {
            return 'unsupported';
        }
        if (!config || config.type !== 'big-query' || config.metadata.authMethod !== BigQueryAuthMethods.GoogleOauth) {
            return 'unsupported';
        }
        try {
            const hasToken = await this.tokenStorage.has(integrationId);
            return hasToken ? 'authenticated' : 'disconnected';
        } catch (err) {
            logger.warn(
                `IntegrationWebviewProvider: failed to check token for ${integrationId}; reporting disconnected.`,
                err
            );
            return 'disconnected';
        }
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
                    await this.saveConfiguration(message.integrationId, message.config);
                }
                break;
            case 'reset':
                if (message.integrationId) {
                    await this.resetConfiguration(message.integrationId);
                }
                break;
            case 'delete':
                if (message.integrationId) {
                    await this.deleteConfiguration(message.integrationId);
                }
                break;
            case 'authenticate':
                if (message.integrationId) {
                    try {
                        await commands.executeCommand(Commands.AuthenticateIntegration, message.integrationId);
                    } catch (error) {
                        // Command handler shows its own toasts; log here to avoid an unhandled-rejection.
                        logger.error(
                            `IntegrationWebviewProvider: AuthenticateIntegration command failed for ${message.integrationId}`,
                            error
                        );
                    }
                }
                break;
        }
    }

    /**
     * Show the configuration form for an integration
     */
    private async showConfigurationForm(integrationId: string): Promise<void> {
        const integration = this.integrations.get(integrationId);
        if (!integration) {
            return;
        }

        await this.currentPanel?.webview.postMessage({
            config: integration.config,
            integrationId,
            integrationName: integration.integrationName,
            integrationType: integration.integrationType,
            type: 'showForm'
        });
    }

    /**
     * Save the configuration for an integration
     */
    private async saveConfiguration(
        integrationId: string,
        config: ConfigurableDatabaseIntegrationConfig
    ): Promise<void> {
        try {
            // Invalidate stale federated tokens before saving (fingerprint change or auth-method switch).
            await this.invalidateStaleFederatedToken(integrationId, config);

            await this.integrationStorage.save(config);

            // Update local state
            const integration = this.integrations.get(integrationId);
            if (integration) {
                // Existing integration - update it
                integration.config = config;
                integration.status = IntegrationStatus.Connected;
                integration.integrationName = config.name;
                integration.integrationType = config.type;
                this.integrations.set(integrationId, integration);
            } else {
                // New integration - add it to the map
                this.integrations.set(integrationId, {
                    config,
                    status: IntegrationStatus.Connected,
                    integrationName: config.name,
                    integrationType: config.type
                });
            }

            // Update the project's integrations list
            await this.updateProjectIntegrationsList();

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: l10n.t('Configuration saved successfully'),
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to save integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to save configuration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });
        }
    }

    /**
     * Reset the configuration for an integration (clears credentials but keeps the integration entry)
     */
    private async resetConfiguration(integrationId: string): Promise<void> {
        try {
            await this.integrationStorage.delete(integrationId);
            await this.tokenStorage?.delete(integrationId).catch((error) => {
                logger.warn(`IntegrationWebviewProvider: failed to delete federated token for ${integrationId}`, error);
            });

            // Update local state
            const integration = this.integrations.get(integrationId);
            if (integration) {
                integration.config = null;
                integration.status = IntegrationStatus.Disconnected;
                this.integrations.set(integrationId, integration);
            }

            // Update the project's integrations list
            await this.updateProjectIntegrationsList();

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: l10n.t('Configuration reset successfully'),
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to reset integration configuration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to reset configuration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });
        }
    }

    /**
     * Delete the integration completely (removes credentials and integration entry)
     */
    private async deleteConfiguration(integrationId: string): Promise<void> {
        try {
            await this.integrationStorage.delete(integrationId);
            await this.tokenStorage?.delete(integrationId).catch((error) => {
                logger.warn(`IntegrationWebviewProvider: failed to delete federated token for ${integrationId}`, error);
            });

            // Remove from local state
            this.integrations.delete(integrationId);

            // Update the project's integrations list
            await this.updateProjectIntegrationsList();

            await this.updateWebview();
            await this.currentPanel?.webview.postMessage({
                message: l10n.t('Integration deleted successfully'),
                type: 'success'
            });
        } catch (error) {
            logger.error('Failed to delete integration', error);
            await this.currentPanel?.webview.postMessage({
                message: l10n.t(
                    'Failed to delete integration: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                ),
                type: 'error'
            });
        }
    }

    /**
     * Update the project's integrations list based on current integrations
     */
    private async updateProjectIntegrationsList(): Promise<void> {
        if (!this.projectId) {
            logger.warn('IntegrationWebviewProvider: No project ID available, skipping project update');
            return;
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

        // Update the project in the notebook manager
        const success = this.notebookManager.updateProjectIntegrations(this.projectId, projectIntegrations);

        if (!success) {
            logger.error(
                `IntegrationWebviewProvider: Failed to update integrations for project ${this.projectId} - project not found`
            );
            void window.showErrorMessage(
                l10n.t('Failed to update integrations: project not found. Please reopen the notebook and try again.')
            );
        }
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
