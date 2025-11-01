import { LegacyIntegrationConfig, LegacyIntegrationType } from './integrationTypes';
import {
    BigQueryAuthMethods,
    DatabaseIntegrationConfig,
    databaseMetadataSchemasByType,
    SnowflakeAuthMethods
} from '@deepnote/database-integrations';
import { SnowflakeAuthMethods as LegacySnowflakeAuthMethods } from './snowflakeAuthConstants';

export async function upgradeLegacyIntegrationConfig(
    config: LegacyIntegrationConfig
): Promise<DatabaseIntegrationConfig | null> {
    switch (config.type) {
        case LegacyIntegrationType.Postgres: {
            const metadata = databaseMetadataSchemasByType.pgsql.safeParse({
                host: config.host,
                port: config.port ? String(config.port) : undefined,
                database: config.database,
                user: config.username,
                password: config.password,
                sslEnabled: config.ssl
            }).data;

            return metadata
                ? {
                      id: config.id,
                      name: config.name,
                      type: 'pgsql',
                      metadata
                  }
                : null;
        }
        case LegacyIntegrationType.BigQuery: {
            const metadata = databaseMetadataSchemasByType['big-query'].safeParse({
                authMethod: BigQueryAuthMethods.ServiceAccount,
                service_account: config.credentials
            }).data;

            return metadata
                ? {
                      id: config.id,
                      name: config.name,
                      type: 'big-query',
                      metadata
                  }
                : null;
        }
        case LegacyIntegrationType.Snowflake: {
            const metadata = (() => {
                switch (config.authMethod) {
                    case LegacySnowflakeAuthMethods.PASSWORD:
                        return databaseMetadataSchemasByType.snowflake.safeParse({
                            authMethod: SnowflakeAuthMethods.Password,
                            accountName: config.account,
                            warehouse: config.warehouse,
                            database: config.database,
                            role: config.role,
                            username: config.username,
                            password: config.password
                        }).data;
                    case LegacySnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR:
                        return databaseMetadataSchemasByType.snowflake.safeParse({
                            authMethod: SnowflakeAuthMethods.ServiceAccountKeyPair,
                            accountName: config.account,
                            warehouse: config.warehouse,
                            database: config.database,
                            role: config.role,
                            username: config.username,
                            privateKey: config.privateKey,
                            privateKeyPassphrase: config.privateKeyPassphrase
                        }).data;
                    default:
                        return null;
                }
            })();

            return metadata
                ? {
                      id: config.id,
                      name: config.name,
                      type: 'snowflake',
                      metadata
                  }
                : null;
        }
        default:
            return null;
    }
}
