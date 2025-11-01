import { assert } from 'chai';

import { upgradeLegacyIntegrationConfig } from './legacyIntegrationConfigUtils';
import {
    LegacyBigQueryIntegrationConfig,
    LegacyIntegrationType,
    LegacyPostgresIntegrationConfig,
    LegacySnowflakeIntegrationConfig,
    SnowflakeAuthMethods
} from './integrationTypes';

suite('upgradeLegacyIntegrationConfig', () => {
    suite('PostgreSQL', () => {
        test('Upgrades valid PostgreSQL config with all fields', async () => {
            const legacyConfig: LegacyPostgresIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
                type: LegacyIntegrationType.Postgres,
                host: 'localhost',
                port: 5432,
                database: 'testdb',
                username: 'testuser',
                password: 'testpass',
                ssl: true
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.strictEqual(result.id, 'postgres-1');
            assert.strictEqual(result.name, 'My Postgres');
            assert.strictEqual(result.type, 'pgsql');
            assert.strictEqual(result.metadata.host, 'localhost');
            assert.strictEqual(result.metadata.port, '5432');
            assert.strictEqual(result.metadata.database, 'testdb');
            assert.strictEqual(result.metadata.user, 'testuser');
            assert.strictEqual(result.metadata.password, 'testpass');
            assert.strictEqual(result.metadata.sslEnabled, true);
        });

        test('Upgrades PostgreSQL config without SSL (defaults to false)', async () => {
            const legacyConfig: LegacyPostgresIntegrationConfig = {
                id: 'postgres-2',
                name: 'My Postgres No SSL',
                type: LegacyIntegrationType.Postgres,
                host: 'localhost',
                port: 5432,
                database: 'testdb',
                username: 'testuser',
                password: 'testpass',
                ssl: false
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.strictEqual(result.metadata.sslEnabled, false);
        });

        test('Converts port number to string', async () => {
            const legacyConfig: LegacyPostgresIntegrationConfig = {
                id: 'postgres-3',
                name: 'My Postgres',
                type: LegacyIntegrationType.Postgres,
                host: 'localhost',
                port: 5433,
                database: 'testdb',
                username: 'testuser',
                password: 'testpass'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.strictEqual(result.metadata.port, '5433');
            assert.strictEqual(typeof result.metadata.port, 'string');
        });

        test('Returns null for PostgreSQL config with missing required fields', async () => {
            const legacyConfig = {
                id: 'postgres-invalid',
                name: 'Invalid Postgres',
                type: LegacyIntegrationType.Postgres,
                host: 'localhost'
                // Missing port, database, username, password
            } as LegacyPostgresIntegrationConfig;

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });
    });

    suite('BigQuery', () => {
        test('Upgrades valid BigQuery config', async () => {
            const credentials = JSON.stringify({
                type: 'service_account',
                project_id: 'my-project',
                private_key_id: 'key123',
                private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
                client_email: 'test@my-project.iam.gserviceaccount.com',
                client_id: '123456789',
                auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                token_uri: 'https://oauth2.googleapis.com/token',
                auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
                client_x509_cert_url:
                    'https://www.googleapis.com/robot/v1/metadata/x509/test%40my-project.iam.gserviceaccount.com'
            });

            const legacyConfig: LegacyBigQueryIntegrationConfig = {
                id: 'bigquery-1',
                name: 'My BigQuery',
                type: LegacyIntegrationType.BigQuery,
                projectId: 'my-project',
                credentials
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.strictEqual(result.id, 'bigquery-1');
            assert.strictEqual(result.name, 'My BigQuery');
            assert.strictEqual(result.type, 'big-query');
            assert.strictEqual(result.metadata.authMethod, 'service-account');
            assert.strictEqual(result.metadata.service_account, credentials);
        });

        test('Returns null for BigQuery config with missing credentials', async () => {
            const legacyConfig = {
                id: 'bigquery-invalid-2',
                name: 'Invalid BigQuery',
                type: LegacyIntegrationType.BigQuery,
                projectId: 'my-project'
            } as LegacyBigQueryIntegrationConfig;

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });
    });

    suite('Snowflake - PASSWORD auth', () => {
        test('Upgrades valid Snowflake config with PASSWORD auth', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-1',
                name: 'My Snowflake',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.PASSWORD,
                account: 'myaccount',
                warehouse: 'mywarehouse',
                database: 'mydb',
                role: 'myrole',
                username: 'myuser',
                password: 'mypass'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.strictEqual(result.id, 'snowflake-1');
            assert.strictEqual(result.name, 'My Snowflake');
            assert.strictEqual(result.type, 'snowflake');
            // The authMethod is converted to the database-integrations format (lowercase/kebab-case)
            assert.ok(result.metadata.authMethod);
            assert.strictEqual(result.metadata.accountName, 'myaccount');
            assert.strictEqual(result.metadata.warehouse, 'mywarehouse');
            assert.strictEqual(result.metadata.database, 'mydb');
            assert.strictEqual(result.metadata.role, 'myrole');
            assert.strictEqual(result.metadata.username, 'myuser');
            assert.strictEqual(result.metadata.password, 'mypass');
        });

        test('Upgrades Snowflake config with PASSWORD auth and minimal fields', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-2',
                name: 'My Snowflake Minimal',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.PASSWORD,
                account: 'myaccount',
                username: 'myuser',
                password: 'mypass'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.ok(result.metadata.authMethod);
            assert.strictEqual(result.metadata.accountName, 'myaccount');
            assert.strictEqual(result.metadata.username, 'myuser');
            assert.strictEqual(result.metadata.password, 'mypass');
        });

        test('Returns null for Snowflake PASSWORD config with missing required fields', async () => {
            const legacyConfig = {
                id: 'snowflake-invalid',
                name: 'Invalid Snowflake',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.PASSWORD,
                account: 'myaccount'
                // Missing username and password
            } as LegacySnowflakeIntegrationConfig;

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });
    });

    suite('Snowflake - SERVICE_ACCOUNT_KEY_PAIR auth', () => {
        test('Upgrades valid Snowflake config with SERVICE_ACCOUNT_KEY_PAIR auth', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-keypair-1',
                name: 'My Snowflake KeyPair',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR,
                account: 'myaccount',
                warehouse: 'mywarehouse',
                database: 'mydb',
                role: 'myrole',
                username: 'myuser',
                privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
                privateKeyPassphrase: 'passphrase'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.strictEqual(result.id, 'snowflake-keypair-1');
            assert.strictEqual(result.name, 'My Snowflake KeyPair');
            assert.strictEqual(result.type, 'snowflake');
            assert.ok(result.metadata.authMethod);
            assert.strictEqual(result.metadata.accountName, 'myaccount');
            assert.strictEqual(result.metadata.username, 'myuser');
            assert.strictEqual(
                result.metadata.privateKey,
                '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n'
            );
            assert.strictEqual(result.metadata.privateKeyPassphrase, 'passphrase');
        });

        test('Upgrades Snowflake SERVICE_ACCOUNT_KEY_PAIR config without passphrase', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-keypair-2',
                name: 'My Snowflake KeyPair No Passphrase',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR,
                account: 'myaccount',
                username: 'myuser',
                privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.ok(result);
            assert.ok(result.metadata.authMethod);
        });

        test('Returns null for Snowflake SERVICE_ACCOUNT_KEY_PAIR config with missing private key', async () => {
            const legacyConfig = {
                id: 'snowflake-keypair-invalid',
                name: 'Invalid Snowflake KeyPair',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR,
                account: 'myaccount',
                username: 'myuser'
                // Missing privateKey
            } as LegacySnowflakeIntegrationConfig;

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });
    });

    suite('Snowflake - Unsupported auth methods', () => {
        test('Returns null for Snowflake config with OKTA auth', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-okta',
                name: 'Snowflake OKTA',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.OKTA,
                account: 'myaccount',
                oktaUrl: 'https://mycompany.okta.com'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });

        test('Returns null for Snowflake config with NATIVE_SNOWFLAKE auth', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-native',
                name: 'Snowflake Native',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.NATIVE_SNOWFLAKE,
                account: 'myaccount'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });

        test('Returns null for Snowflake config with AZURE_AD auth', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-azure',
                name: 'Snowflake Azure AD',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.AZURE_AD,
                account: 'myaccount',
                tenantId: 'my-tenant-id'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });

        test('Returns null for Snowflake config with KEY_PAIR auth', async () => {
            const legacyConfig: LegacySnowflakeIntegrationConfig = {
                id: 'snowflake-keypair',
                name: 'Snowflake KeyPair',
                type: LegacyIntegrationType.Snowflake,
                authMethod: SnowflakeAuthMethods.KEY_PAIR,
                account: 'myaccount'
            };

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });
    });

    suite('Unknown integration types', () => {
        test('Returns null for unknown integration type', async () => {
            const legacyConfig = {
                id: 'unknown-1',
                name: 'Unknown Integration',
                type: 'unknown-type'
            } as any;

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });

        test('Returns null for DuckDB integration type', async () => {
            const legacyConfig = {
                id: 'duckdb-1',
                name: 'DuckDB',
                type: LegacyIntegrationType.DuckDB
            } as any;

            const result = await upgradeLegacyIntegrationConfig(legacyConfig);

            assert.strictEqual(result, null);
        });
    });
});
