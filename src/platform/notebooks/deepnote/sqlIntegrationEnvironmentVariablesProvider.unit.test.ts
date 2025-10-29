import { assert } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import { CancellationTokenSource, EventEmitter, NotebookCell, NotebookCellKind, NotebookDocument, Uri } from 'vscode';

import { IDisposableRegistry } from '../../common/types';
import { IntegrationStorage } from './integrationStorage';
import { SqlIntegrationEnvironmentVariablesProvider } from './sqlIntegrationEnvironmentVariablesProvider';
import {
    IntegrationType,
    PostgresIntegrationConfig,
    BigQueryIntegrationConfig,
    SnowflakeIntegrationConfig,
    SnowflakeAuthMethods
} from './integrationTypes';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';

suite('SqlIntegrationEnvironmentVariablesProvider', () => {
    let provider: SqlIntegrationEnvironmentVariablesProvider;
    let integrationStorage: IntegrationStorage;
    let disposables: IDisposableRegistry;

    setup(() => {
        resetVSCodeMocks();
        disposables = [];
        integrationStorage = mock(IntegrationStorage);
        when(integrationStorage.onDidChangeIntegrations).thenReturn(new EventEmitter<void>().event);

        provider = new SqlIntegrationEnvironmentVariablesProvider(instance(integrationStorage), disposables);
    });

    teardown(() => {
        disposables.forEach((d) => d.dispose());
    });

    test('Returns empty object when resource is undefined', async () => {
        const envVars = await provider.getEnvironmentVariables(undefined);
        assert.deepStrictEqual(envVars, {});
    });

    test('Returns empty object when notebook is not found', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([]);

        const envVars = await provider.getEnvironmentVariables(uri);
        assert.deepStrictEqual(envVars, {});
    });

    test('Returns empty object when notebook has no SQL cells', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'python', 'print("hello")'),
            createMockCell(1, NotebookCellKind.Markup, 'markdown', '# Title')
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const envVars = await provider.getEnvironmentVariables(uri);
        assert.deepStrictEqual(envVars, {});
    });

    test('Returns empty object when SQL cells have no integration ID', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM users', {})
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const envVars = await provider.getEnvironmentVariables(uri);
        assert.deepStrictEqual(envVars, {});
    });

    test('Returns environment variable for internal DuckDB integration', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM df', {
                sql_integration_id: 'deepnote-dataframe-sql'
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Check that the environment variable is set for dataframe SQL
        assert.property(envVars, 'SQL_DEEPNOTE_DATAFRAME_SQL');
        const credentialsJson = JSON.parse(envVars['SQL_DEEPNOTE_DATAFRAME_SQL']!);
        assert.strictEqual(credentialsJson.url, 'deepnote+duckdb:///:memory:');
        assert.deepStrictEqual(credentialsJson.params, {});
        assert.strictEqual(credentialsJson.param_style, 'qmark');
    });

    test('Returns environment variable for PostgreSQL integration', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'my-postgres-db';
        const config: PostgresIntegrationConfig = {
            id: integrationId,
            name: 'My Postgres DB',
            type: IntegrationType.Postgres,
            host: 'localhost',
            port: 5432,
            database: 'mydb',
            username: 'user',
            password: 'pass',
            ssl: true
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM users', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Check that the environment variable is set
        assert.property(envVars, 'SQL_MY_POSTGRES_DB');
        const credentialsJson = JSON.parse(envVars['SQL_MY_POSTGRES_DB']!);
        assert.strictEqual(credentialsJson.url, 'postgresql://user:pass@localhost:5432/mydb');
        assert.deepStrictEqual(credentialsJson.params, { sslmode: 'require' });
        assert.strictEqual(credentialsJson.param_style, 'format');
    });

    test('Returns environment variable for BigQuery integration', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'my-bigquery';
        const serviceAccountJson = JSON.stringify({ type: 'service_account', project_id: 'my-project' });
        const config: BigQueryIntegrationConfig = {
            id: integrationId,
            name: 'My BigQuery',
            type: IntegrationType.BigQuery,
            projectId: 'my-project',
            credentials: serviceAccountJson
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM dataset.table', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Check that the environment variable is set
        assert.property(envVars, 'SQL_MY_BIGQUERY');
        const credentialsJson = JSON.parse(envVars['SQL_MY_BIGQUERY']!);
        assert.strictEqual(credentialsJson.url, 'bigquery://?user_supplied_client=true');
        assert.deepStrictEqual(credentialsJson.params, {
            project_id: 'my-project',
            credentials: { type: 'service_account', project_id: 'my-project' }
        });
        assert.strictEqual(credentialsJson.param_style, 'format');
    });

    test('Handles multiple SQL cells with same integration', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'my-postgres-db';
        const config: PostgresIntegrationConfig = {
            id: integrationId,
            name: 'My Postgres DB',
            type: IntegrationType.Postgres,
            host: 'localhost',
            port: 5432,
            database: 'mydb',
            username: 'user',
            password: 'pass'
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM users', {
                sql_integration_id: integrationId
            }),
            createMockCell(1, NotebookCellKind.Code, 'sql', 'SELECT * FROM orders', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Should only have one environment variable
        assert.property(envVars, 'SQL_MY_POSTGRES_DB');
        assert.strictEqual(Object.keys(envVars).length, 1);
    });

    test('Handles multiple SQL cells with different integrations', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const postgresId = 'my-postgres-db';
        const bigqueryId = 'my-bigquery';

        const postgresConfig: PostgresIntegrationConfig = {
            id: postgresId,
            name: 'My Postgres DB',
            type: IntegrationType.Postgres,
            host: 'localhost',
            port: 5432,
            database: 'mydb',
            username: 'user',
            password: 'pass'
        };

        const bigqueryConfig: BigQueryIntegrationConfig = {
            id: bigqueryId,
            name: 'My BigQuery',
            type: IntegrationType.BigQuery,
            projectId: 'my-project',
            credentials: JSON.stringify({ type: 'service_account' })
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM users', {
                sql_integration_id: postgresId
            }),
            createMockCell(1, NotebookCellKind.Code, 'sql', 'SELECT * FROM dataset.table', {
                sql_integration_id: bigqueryId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(postgresId)).thenResolve(postgresConfig);
        when(integrationStorage.getIntegrationConfig(bigqueryId)).thenResolve(bigqueryConfig);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Should have two environment variables
        assert.property(envVars, 'SQL_MY_POSTGRES_DB');
        assert.property(envVars, 'SQL_MY_BIGQUERY');
        assert.strictEqual(Object.keys(envVars).length, 2);
    });

    test('Handles missing integration configuration gracefully', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'missing-integration';

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM users', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(undefined);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Should return empty object when integration config is missing
        assert.deepStrictEqual(envVars, {});
    });

    test('Properly encodes special characters in PostgreSQL credentials', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'special-chars-db';
        const config: PostgresIntegrationConfig = {
            id: integrationId,
            name: 'Special Chars DB',
            type: IntegrationType.Postgres,
            host: 'db.example.com',
            port: 5432,
            database: 'my@db:name',
            username: 'user@domain',
            password: 'pa:ss@word!#$%',
            ssl: false
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM users', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Check that the environment variable is set
        assert.property(envVars, 'SQL_SPECIAL_CHARS_DB');
        const credentialsJson = JSON.parse(envVars['SQL_SPECIAL_CHARS_DB']!);

        // Verify that special characters are properly URL-encoded
        assert.strictEqual(
            credentialsJson.url,
            'postgresql://user%40domain:pa%3Ass%40word!%23%24%25@db.example.com:5432/my%40db%3Aname'
        );
        assert.deepStrictEqual(credentialsJson.params, {});
        assert.strictEqual(credentialsJson.param_style, 'format');
    });

    test('Normalizes integration ID with spaces and mixed case for env var name', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'My Production DB';
        const config: PostgresIntegrationConfig = {
            id: integrationId,
            name: 'Production Database',
            type: IntegrationType.Postgres,
            host: 'prod.example.com',
            port: 5432,
            database: 'proddb',
            username: 'admin',
            password: 'secret',
            ssl: true
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM products', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Check that the environment variable name is properly normalized
        // Spaces should be converted to underscores and uppercased
        assert.property(envVars, 'SQL_MY_PRODUCTION_DB');
        const credentialsJson = JSON.parse(envVars['SQL_MY_PRODUCTION_DB']!);
        assert.strictEqual(credentialsJson.url, 'postgresql://admin:secret@prod.example.com:5432/proddb');
        assert.deepStrictEqual(credentialsJson.params, { sslmode: 'require' });
        assert.strictEqual(credentialsJson.param_style, 'format');
    });

    test('Normalizes integration ID with special characters for env var name', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'my-db@2024!';
        const config: PostgresIntegrationConfig = {
            id: integrationId,
            name: 'Test DB',
            type: IntegrationType.Postgres,
            host: 'localhost',
            port: 5432,
            database: 'testdb',
            username: 'user',
            password: 'pass',
            ssl: false
        };

        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                sql_integration_id: integrationId
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Check that special characters in integration ID are normalized for env var name
        // Non-alphanumeric characters should be converted to underscores
        assert.property(envVars, 'SQL_MY_DB_2024_');
        const credentialsJson = JSON.parse(envVars['SQL_MY_DB_2024_']!);
        assert.strictEqual(credentialsJson.url, 'postgresql://user:pass@localhost:5432/testdb');
    });

    test('Honors CancellationToken (returns empty when cancelled early)', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const integrationId = 'cancel-me';
        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', { sql_integration_id: integrationId })
        ]);
        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
        // Return a slow promise to ensure cancellation path is hit
        when(integrationStorage.getIntegrationConfig(integrationId)).thenCall(
            () => new Promise((resolve) => setTimeout(() => resolve(undefined), 50))
        );
        const cts = new CancellationTokenSource();
        cts.cancel();
        const envVars = await provider.getEnvironmentVariables(uri, cts.token);
        assert.deepStrictEqual(envVars, {});
    });

    suite('Snowflake Integration', () => {
        test('Returns environment variable for Snowflake with PASSWORD auth', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'my-snowflake';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'My Snowflake',
                type: IntegrationType.Snowflake,
                account: 'myorg-myaccount',
                warehouse: 'COMPUTE_WH',
                database: 'MYDB',
                role: 'ANALYST',
                authMethod: SnowflakeAuthMethods.PASSWORD,
                username: 'john.doe',
                password: 'secret123'
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM customers', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);

            assert.property(envVars, 'SQL_MY_SNOWFLAKE');
            const credentialsJson = JSON.parse(envVars['SQL_MY_SNOWFLAKE']!);
            assert.strictEqual(
                credentialsJson.url,
                'snowflake://john.doe:secret123@myorg-myaccount/MYDB?warehouse=COMPUTE_WH&role=ANALYST&application=Deepnote'
            );
            assert.deepStrictEqual(credentialsJson.params, {});
            assert.strictEqual(credentialsJson.param_style, 'format');
        });

        test('Returns environment variable for Snowflake with legacy null auth (username+password)', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'legacy-snowflake';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Legacy Snowflake',
                type: IntegrationType.Snowflake,
                account: 'legacy-account',
                warehouse: 'WH',
                database: 'DB',
                authMethod: null,
                username: 'user',
                password: 'pass'
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);

            assert.property(envVars, 'SQL_LEGACY_SNOWFLAKE');
            const credentialsJson = JSON.parse(envVars['SQL_LEGACY_SNOWFLAKE']!);
            assert.strictEqual(
                credentialsJson.url,
                'snowflake://user:pass@legacy-account/DB?warehouse=WH&application=Deepnote'
            );
            assert.deepStrictEqual(credentialsJson.params, {});
        });

        test('Returns environment variable for Snowflake with SERVICE_ACCOUNT_KEY_PAIR auth', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-keypair';
            const privateKey =
                '-----BEGIN ' + 'PRIVATE KEY-----\nfakekey-MIIEvQIBADANBg...\n-----END ' + 'PRIVATE KEY-----';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake KeyPair',
                type: IntegrationType.Snowflake,
                account: 'keypair-account',
                warehouse: 'ETL_WH',
                database: 'PROD_DB',
                role: 'ETL_ROLE',
                authMethod: SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR,
                username: 'service_account',
                privateKey: privateKey,
                privateKeyPassphrase: 'passphrase123'
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM events', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);

            assert.property(envVars, 'SQL_SNOWFLAKE_KEYPAIR');
            const credentialsJson = JSON.parse(envVars['SQL_SNOWFLAKE_KEYPAIR']!);
            assert.strictEqual(
                credentialsJson.url,
                'snowflake://service_account@keypair-account/PROD_DB?warehouse=ETL_WH&role=ETL_ROLE&authenticator=snowflake_jwt&application=Deepnote'
            );
            assert.deepStrictEqual(credentialsJson.params, {
                snowflake_private_key: Buffer.from(privateKey).toString('base64'),
                snowflake_private_key_passphrase: 'passphrase123'
            });
            assert.strictEqual(credentialsJson.param_style, 'format');
        });

        test('Returns environment variable for Snowflake with SERVICE_ACCOUNT_KEY_PAIR auth without passphrase', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-keypair-no-pass';
            const privateKey =
                '-----BEGIN ' + 'PRIVATE KEY-----\nfakekey-MIIEvQIBADANBg...\n-----END ' + 'PRIVATE KEY-----';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake KeyPair No Pass',
                type: IntegrationType.Snowflake,
                account: 'account123',
                warehouse: 'WH',
                database: 'DB',
                authMethod: SnowflakeAuthMethods.SERVICE_ACCOUNT_KEY_PAIR,
                username: 'svc_user',
                privateKey: privateKey
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);

            assert.property(envVars, 'SQL_SNOWFLAKE_KEYPAIR_NO_PASS');
            const credentialsJson = JSON.parse(envVars['SQL_SNOWFLAKE_KEYPAIR_NO_PASS']!);
            assert.strictEqual(
                credentialsJson.url,
                'snowflake://svc_user@account123/DB?warehouse=WH&authenticator=snowflake_jwt&application=Deepnote'
            );
            assert.deepStrictEqual(credentialsJson.params, {
                snowflake_private_key: Buffer.from(privateKey).toString('base64')
            });
        });

        test('Properly encodes special characters in Snowflake credentials', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-special';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake Special',
                type: IntegrationType.Snowflake,
                account: 'my-org.account',
                warehouse: 'WH@2024',
                database: 'DB:TEST',
                role: 'ROLE#1',
                authMethod: SnowflakeAuthMethods.PASSWORD,
                username: 'user@domain.com',
                password: 'p@ss:word!#$%'
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);

            assert.property(envVars, 'SQL_SNOWFLAKE_SPECIAL');
            const credentialsJson = JSON.parse(envVars['SQL_SNOWFLAKE_SPECIAL']!);
            // Verify URL encoding of special characters
            assert.strictEqual(
                credentialsJson.url,
                'snowflake://user%40domain.com:p%40ss%3Aword!%23%24%25@my-org.account/DB%3ATEST?warehouse=WH%402024&role=ROLE%231&application=Deepnote'
            );
        });

        test('Handles Snowflake with minimal optional fields', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-minimal';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake Minimal',
                type: IntegrationType.Snowflake,
                account: 'minimal-account',
                authMethod: SnowflakeAuthMethods.PASSWORD,
                username: 'user',
                password: 'pass'
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);

            assert.property(envVars, 'SQL_SNOWFLAKE_MINIMAL');
            const credentialsJson = JSON.parse(envVars['SQL_SNOWFLAKE_MINIMAL']!);
            // Should not include warehouse, database, or role in URL when not provided
            assert.strictEqual(credentialsJson.url, 'snowflake://user:pass@minimal-account?application=Deepnote');
            assert.strictEqual(credentialsJson.param_style, 'format');
        });

        test('Skips unsupported Snowflake auth method (OKTA)', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-okta';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake OKTA',
                type: IntegrationType.Snowflake,
                account: 'okta-account',
                authMethod: SnowflakeAuthMethods.OKTA
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            // Should return empty object when unsupported auth method is encountered
            const envVars = await provider.getEnvironmentVariables(uri);
            assert.deepStrictEqual(envVars, {});
        });

        test('Skips unsupported Snowflake auth method (AZURE_AD)', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-azure';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake Azure',
                type: IntegrationType.Snowflake,
                account: 'azure-account',
                authMethod: SnowflakeAuthMethods.AZURE_AD
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);
            assert.deepStrictEqual(envVars, {});
        });

        test('Skips unsupported Snowflake auth method (KEY_PAIR)', async () => {
            const uri = Uri.file('/test/notebook.deepnote');
            const integrationId = 'snowflake-keypair-user';
            const config: SnowflakeIntegrationConfig = {
                id: integrationId,
                name: 'Snowflake KeyPair User',
                type: IntegrationType.Snowflake,
                account: 'keypair-user-account',
                authMethod: SnowflakeAuthMethods.KEY_PAIR
            };

            const notebook = createMockNotebook(uri, [
                createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT 1', {
                    sql_integration_id: integrationId
                })
            ]);

            when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);
            when(integrationStorage.getIntegrationConfig(integrationId)).thenResolve(config);

            const envVars = await provider.getEnvironmentVariables(uri);
            assert.deepStrictEqual(envVars, {});
        });
    });
});

function createMockNotebook(uri: Uri, cells: NotebookCell[]): NotebookDocument {
    return {
        uri,
        getCells: () => cells
    } as NotebookDocument;
}

function createMockCell(
    index: number,
    kind: NotebookCellKind,
    languageId: string,
    value: string,
    metadata?: Record<string, unknown>
): NotebookCell {
    return {
        index,
        kind,
        document: {
            languageId,
            getText: () => value
        },
        metadata: metadata || {}
    } as NotebookCell;
}
