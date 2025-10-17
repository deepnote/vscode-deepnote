import { assert } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import { EventEmitter, NotebookCell, NotebookCellKind, NotebookDocument, Uri } from 'vscode';

import { IDisposableRegistry } from '../../common/types';
import { IntegrationStorage } from './integrationStorage';
import { SqlIntegrationEnvironmentVariablesProvider } from './sqlIntegrationEnvironmentVariablesProvider';
import { IntegrationType, PostgresIntegrationConfig, BigQueryIntegrationConfig } from './integrationTypes';
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

    test('Skips internal DuckDB integration', async () => {
        const uri = Uri.file('/test/notebook.deepnote');
        const notebook = createMockNotebook(uri, [
            createMockCell(0, NotebookCellKind.Code, 'sql', 'SELECT * FROM df', {
                sql_integration_id: 'deepnote-dataframe-sql'
            })
        ]);

        when(mockedVSCodeNamespaces.workspace.notebookDocuments).thenReturn([notebook]);

        const envVars = await provider.getEnvironmentVariables(uri);
        assert.deepStrictEqual(envVars, {});
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
        when(integrationStorage.get(integrationId)).thenResolve(config);

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
        when(integrationStorage.get(integrationId)).thenResolve(config);

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
        when(integrationStorage.get(integrationId)).thenResolve(config);

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
        when(integrationStorage.get(postgresId)).thenResolve(postgresConfig);
        when(integrationStorage.get(bigqueryId)).thenResolve(bigqueryConfig);

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
        when(integrationStorage.get(integrationId)).thenResolve(undefined);

        const envVars = await provider.getEnvironmentVariables(uri);

        // Should return empty object when integration config is missing
        assert.deepStrictEqual(envVars, {});
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
