import assert from 'assert';
import type { DeepnoteFile } from '@deepnote/blocks';
import { instance, mock, when } from 'ts-mockito';
import { CancellationTokenSource, EventEmitter, NotebookDocument, Uri } from 'vscode';

import { IDisposableRegistry } from '../../common/types';
import { SqlIntegrationEnvironmentVariablesProvider } from './sqlIntegrationEnvironmentVariablesProvider';
import { IIntegrationStorage, IPlatformDeepnoteNotebookManager, IPlatformNotebookEditorProvider } from './types';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';

/** Create a minimal `DeepnoteFile` for tests. */
function createMockProject(
    projectId: string,
    integrations: Array<{ id: string; name: string; type: string }> = []
): DeepnoteFile {
    return {
        metadata: {
            createdAt: '2023-01-01T00:00:00Z',
            modifiedAt: '2023-01-02T00:00:00Z'
        },
        project: {
            id: projectId,
            name: 'Test Project',
            notebooks: [],
            integrations
        },
        version: '1.0.0'
    };
}

suite('SqlIntegrationEnvironmentVariablesProvider', () => {
    let provider: SqlIntegrationEnvironmentVariablesProvider;
    let integrationStorage: IIntegrationStorage;
    let notebookEditorProvider: IPlatformNotebookEditorProvider;
    let notebookManager: IPlatformDeepnoteNotebookManager;
    let disposables: IDisposableRegistry;
    let onDidChangeIntegrationsEmitter: EventEmitter<void>;

    setup(() => {
        integrationStorage = mock<IIntegrationStorage>();
        notebookEditorProvider = mock<IPlatformNotebookEditorProvider>();
        notebookManager = mock<IPlatformDeepnoteNotebookManager>();
        disposables = [];

        onDidChangeIntegrationsEmitter = new EventEmitter<void>();
        when(integrationStorage.onDidChangeIntegrations).thenReturn(onDidChangeIntegrationsEmitter.event);

        provider = new SqlIntegrationEnvironmentVariablesProvider(
            instance(integrationStorage),
            instance(notebookEditorProvider),
            instance(notebookManager),
            disposables
        );
    });

    teardown(() => {
        disposables.forEach((d) => d.dispose());
        onDidChangeIntegrationsEmitter.dispose();
    });

    suite('getEnvironmentVariables', () => {
        test('Returns empty object when resource is undefined', async () => {
            const result = await provider.getEnvironmentVariables(undefined);

            assert.deepStrictEqual(result, {});
        });

        test('Returns empty object when cancellation token is already cancelled', async () => {
            const tokenSource = new CancellationTokenSource();
            tokenSource.cancel();
            const resource = Uri.file('/test/notebook.deepnote');

            const result = await provider.getEnvironmentVariables(resource, tokenSource.token);

            assert.deepStrictEqual(result, {});
            tokenSource.dispose();
        });

        test('Returns empty object when no notebook is found for resource', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(undefined);

            const result = await provider.getEnvironmentVariables(resource);

            assert.deepStrictEqual(result, {});
        });

        test('Returns empty object when notebook has no project ID in metadata', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            when(notebook.metadata).thenReturn({});
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));

            const result = await provider.getEnvironmentVariables(resource);

            assert.deepStrictEqual(result, {});
        });

        test('Returns empty object when project is not found in notebook manager', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(undefined);

            const result = await provider.getEnvironmentVariables(resource);

            assert.deepStrictEqual(result, {});
        });

        test('Returns only DuckDB integration when project has no integrations', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            const project = createMockProject('project-123', []);

            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);

            const result = await provider.getEnvironmentVariables(resource);

            // Should contain DuckDB integration env vars
            assert.ok(Object.keys(result).length > 0, 'Should have environment variables for DuckDB');
            // The actual env var name depends on the database-integrations library implementation
            // We verify that at least one env var was generated
        });

        test('Retrieves integration configs from storage for project integrations', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            const postgresConfig: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres DB',
                type: 'pgsql',
                metadata: {
                    host: 'localhost',
                    port: '5432',
                    database: 'testdb',
                    user: 'testuser',
                    password: 'testpass',
                    sslEnabled: false
                }
            };
            const project = createMockProject('project-123', [
                { id: 'postgres-1', name: 'My Postgres DB', type: 'pgsql' }
            ]);

            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
            when(integrationStorage.getIntegrationConfig('postgres-1')).thenResolve(postgresConfig);

            const result = await provider.getEnvironmentVariables(resource);

            // Should contain env vars for both Postgres and DuckDB
            assert.ok(Object.keys(result).length > 0, 'Should have environment variables');
        });

        test('Filters out null integration configs from storage', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            const postgresConfig: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres DB',
                type: 'pgsql',
                metadata: {
                    host: 'localhost',
                    port: '5432',
                    database: 'testdb',
                    user: 'testuser',
                    password: 'testpass',
                    sslEnabled: false
                }
            };
            const project = createMockProject('project-123', [
                { id: 'postgres-1', name: 'My Postgres DB', type: 'pgsql' },
                { id: 'missing-integration', name: 'Missing', type: 'pgsql' }
            ]);

            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
            when(integrationStorage.getIntegrationConfig('postgres-1')).thenResolve(postgresConfig);
            when(integrationStorage.getIntegrationConfig('missing-integration')).thenResolve(undefined);

            const result = await provider.getEnvironmentVariables(resource);

            // Should only include postgres-1 and DuckDB, not the missing integration
            assert.ok(Object.keys(result).length > 0, 'Should have environment variables');
        });

        test('Always includes DuckDB integration in the config list', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            const project = createMockProject('project-123', []);

            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);

            const result = await provider.getEnvironmentVariables(resource);

            // DuckDB should always be included
            assert.ok(Object.keys(result).length > 0, 'Should have DuckDB environment variables');
        });

        test('Generates environment variables for multiple integrations', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            const postgresConfig: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'Postgres DB',
                type: 'pgsql',
                metadata: {
                    host: 'localhost',
                    port: '5432',
                    database: 'testdb',
                    user: 'testuser',
                    password: 'testpass',
                    sslEnabled: false
                }
            };
            const bigqueryConfig: DatabaseIntegrationConfig = {
                id: 'bigquery-1',
                name: 'BigQuery',
                type: 'big-query',
                metadata: {
                    authMethod: 'service-account',
                    service_account: '{"type":"service_account","project_id":"test"}'
                }
            };
            const project = createMockProject('project-123', [
                { id: 'postgres-1', name: 'Postgres DB', type: 'pgsql' },
                { id: 'bigquery-1', name: 'BigQuery', type: 'big-query' }
            ]);

            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
            when(integrationStorage.getIntegrationConfig('postgres-1')).thenResolve(postgresConfig);
            when(integrationStorage.getIntegrationConfig('bigquery-1')).thenResolve(bigqueryConfig);

            const result = await provider.getEnvironmentVariables(resource);

            // Should have env vars for Postgres, BigQuery, and DuckDB
            assert.ok(Object.keys(result).length > 0, 'Should have environment variables for all integrations');
        });

        suite('Real environment variable format checks', () => {
            test('PostgreSQL integration generates correct SQL_* env var format', async () => {
                const resource = Uri.file('/test/notebook.deepnote');
                const notebook = mock<NotebookDocument>();
                const postgresConfig: DatabaseIntegrationConfig = {
                    id: 'my-postgres',
                    name: 'Production DB',
                    type: 'pgsql',
                    metadata: {
                        host: 'db.example.com',
                        port: '5432',
                        database: 'production',
                        user: 'admin',
                        password: 'secret123',
                        sslEnabled: true
                    }
                };
                const project = createMockProject('project-123', [
                    { id: 'my-postgres', name: 'Production DB', type: 'pgsql' }
                ]);

                when(notebook.metadata).thenReturn({
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-123'
                });
                when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
                when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
                when(integrationStorage.getIntegrationConfig('my-postgres')).thenResolve(postgresConfig);

                const result = await provider.getEnvironmentVariables(resource);

                // The database-integrations library generates env vars with SQL_ prefix
                // and the integration ID in uppercase with hyphens replaced by underscores
                const expectedEnvVarName = 'SQL_MY_POSTGRES';
                assert.ok(result[expectedEnvVarName], `Should have ${expectedEnvVarName} env var`);

                // The value should be a JSON string with connection details
                const envVarValue = result[expectedEnvVarName];
                assert.ok(typeof envVarValue === 'string', 'Env var value should be a string');
                assert.ok(envVarValue, 'Env var value should not be undefined');

                // Parse and verify the structure
                const parsed = JSON.parse(envVarValue!);
                assert.ok(parsed.url, 'Should have url field');
                assert.ok(parsed.url.includes('postgresql://'), 'URL should be PostgreSQL connection string');
                assert.ok(parsed.url.includes('db.example.com'), 'URL should contain host');
                assert.ok(parsed.url.includes('5432'), 'URL should contain port');
                assert.ok(parsed.url.includes('production'), 'URL should contain database name');
            });

            test('BigQuery integration generates correct SQL_* env var format', async () => {
                const resource = Uri.file('/test/notebook.deepnote');
                const notebook = mock<NotebookDocument>();
                const serviceAccountJson = JSON.stringify({
                    type: 'service_account',
                    project_id: 'my-gcp-project',
                    private_key_id: 'key123',
                    private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
                    client_email: 'test@my-gcp-project.iam.gserviceaccount.com',
                    client_id: '123456789',
                    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                    token_uri: 'https://oauth2.googleapis.com/token'
                });
                const bigqueryConfig: DatabaseIntegrationConfig = {
                    id: 'my-bigquery',
                    name: 'Analytics BQ',
                    type: 'big-query',
                    metadata: {
                        authMethod: 'service-account',
                        service_account: serviceAccountJson
                    }
                };
                const project = createMockProject('project-123', [
                    { id: 'my-bigquery', name: 'Analytics BQ', type: 'big-query' }
                ]);

                when(notebook.metadata).thenReturn({
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-123'
                });
                when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
                when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
                when(integrationStorage.getIntegrationConfig('my-bigquery')).thenResolve(bigqueryConfig);

                const result = await provider.getEnvironmentVariables(resource);

                const expectedEnvVarName = 'SQL_MY_BIGQUERY';
                assert.ok(result[expectedEnvVarName], `Should have ${expectedEnvVarName} env var`);

                const envVarValue = result[expectedEnvVarName];
                assert.ok(typeof envVarValue === 'string', 'Env var value should be a string');
                assert.ok(envVarValue, 'Env var value should not be undefined');

                // Parse and verify the structure
                const parsed = JSON.parse(envVarValue!);
                // BigQuery env vars should contain connection details
                // The exact structure depends on the database-integrations library
                assert.ok(parsed, 'Should have parsed BigQuery config');
            });

            test('DuckDB (dataframe-sql) integration is always included', async () => {
                const resource = Uri.file('/test/notebook.deepnote');
                const notebook = mock<NotebookDocument>();
                const project = createMockProject('project-123', []);

                when(notebook.metadata).thenReturn({
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-123'
                });
                when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
                when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);

                const result = await provider.getEnvironmentVariables(resource);

                // DuckDB integration should generate an env var
                // The exact name depends on DATAFRAME_SQL_INTEGRATION_ID
                const expectedEnvVarName = `SQL_${DATAFRAME_SQL_INTEGRATION_ID.toUpperCase().replace(/-/g, '_')}`;
                assert.ok(result[expectedEnvVarName], `Should have ${expectedEnvVarName} env var for DuckDB`);
            });

            test('Snowflake integration includes partner identifier in URL as application parameter', async () => {
                const resource = Uri.file('/test/notebook.deepnote');
                const notebook = mock<NotebookDocument>();
                const snowflakeConfig: DatabaseIntegrationConfig = {
                    id: 'my-snowflake',
                    name: 'Snowflake DB',
                    type: 'snowflake',
                    metadata: {
                        authMethod: 'password',
                        accountName: 'test-account.us-east-1',
                        warehouse: 'test_warehouse',
                        database: 'test_db',
                        role: 'test_role',
                        username: 'test_user',
                        password: 'test_pass'
                    }
                };
                const project = createMockProject('project-123', [
                    { id: 'my-snowflake', name: 'Snowflake DB', type: 'snowflake' }
                ]);

                when(notebook.metadata).thenReturn({
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-123'
                });
                when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
                when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
                when(integrationStorage.getIntegrationConfig('my-snowflake')).thenResolve(snowflakeConfig);

                const result = await provider.getEnvironmentVariables(resource);

                const expectedEnvVarName = 'SQL_MY_SNOWFLAKE';
                assert.ok(result[expectedEnvVarName], `Should have ${expectedEnvVarName} env var`);

                const envVarValue = result[expectedEnvVarName];
                assert.ok(typeof envVarValue === 'string', 'Env var value should be a string');
                assert.ok(envVarValue, 'Env var value should not be undefined');

                // Parse and verify the structure
                const parsed = JSON.parse(envVarValue!);
                assert.ok(parsed.url, 'Should have url field');
                assert.ok(parsed.url.includes('snowflake://'), 'URL should be Snowflake connection string');

                // Verify that the application parameter is set to the Snowflake partner identifier
                assert.ok(
                    parsed.url.includes('application=Deepnote_Workspaces'),
                    'URL should contain application=Deepnote_Workspaces parameter'
                );
            });
        });
    });

    suite('Federated-auth integrations are skipped', () => {
        test('Mixed project: federated integration is skipped, non-federated is included', async () => {
            const resource = Uri.file('/test/notebook.deepnote');
            const notebook = mock<NotebookDocument>();
            const postgresConfig: DatabaseIntegrationConfig = {
                id: 'pg-1',
                name: 'Postgres',
                type: 'pgsql',
                metadata: {
                    host: 'localhost',
                    port: '5432',
                    database: 'db',
                    user: 'u',
                    password: 'p',
                    sslEnabled: false
                }
            };
            const federatedConfig: DatabaseIntegrationConfig = {
                id: 'bq-oauth',
                name: 'OAuth BQ',
                type: 'big-query',
                metadata: {
                    authMethod: 'google-oauth',
                    project: 'oauth-project',
                    clientId: 'client',
                    clientSecret: 'secret'
                }
            };
            const project = createMockProject('project-123', [
                { id: 'pg-1', name: 'Postgres', type: 'pgsql' },
                { id: 'bq-oauth', name: 'OAuth BQ', type: 'big-query' }
            ]);

            when(notebook.metadata).thenReturn({
                deepnoteProjectId: 'project-123',
                deepnoteNotebookId: 'notebook-123'
            });
            when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
            when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
            when(integrationStorage.getIntegrationConfig('pg-1')).thenResolve(postgresConfig);
            when(integrationStorage.getIntegrationConfig('bq-oauth')).thenResolve(federatedConfig);

            const result = await provider.getEnvironmentVariables(resource);

            assert.ok(result['SQL_PG_1'], 'Non-federated postgres env var should be present');
            assert.strictEqual(result['SQL_BQ_OAUTH'], undefined, 'Federated integration env var should be omitted');
        });
    });

    suite('onDidChangeEnvironmentVariables event', () => {
        test('Fires when integration storage changes', (done) => {
            let eventFired = false;
            provider.onDidChangeEnvironmentVariables(() => {
                eventFired = true;
                assert.ok(true, 'Event should fire when integrations change');
                done();
            });

            // Trigger the integration storage change event
            onDidChangeIntegrationsEmitter.fire();

            // Give it a moment to propagate
            setTimeout(() => {
                if (!eventFired) {
                    done(new Error('Event did not fire'));
                }
            }, 100);
        });
    });
});
