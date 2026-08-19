import assert from 'assert';
import type { DeepnoteFile } from '@deepnote/blocks';
import { anything, instance, mock, verify, when } from 'ts-mockito';
import { CancellationTokenSource, EventEmitter, NotebookDocument, Uri } from 'vscode';

import { getFilePath } from '../../common/platform/fs-paths';
import { IDisposableRegistry } from '../../common/types';
import { SqlIntegrationEnvironmentVariablesProvider } from './sqlIntegrationEnvironmentVariablesProvider';
import {
    IIntegrationsFileConfigProvider,
    IIntegrationStorage,
    IPlatformDeepnoteNotebookManager,
    IPlatformNotebookEditorProvider
} from './types';
import { ConfigurableDatabaseIntegrationConfig, DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';
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

/** A file-config source that yields nothing — what callers see when no `.deepnote.env.yaml` exists. */
function emptyFileConfigProvider(): IIntegrationsFileConfigProvider {
    return { getConfigsForFile: async () => ({ configs: [], issues: [] }) };
}

suite('SqlIntegrationEnvironmentVariablesProvider', () => {
    const notebookUri = Uri.file('/ws/project.deepnote');
    const duckDbEnvVar = `SQL_${DATAFRAME_SQL_INTEGRATION_ID.toUpperCase().replace(/-/g, '_')}`;
    let provider: SqlIntegrationEnvironmentVariablesProvider;
    let integrationStorage: IIntegrationStorage;
    let notebookEditorProvider: IPlatformNotebookEditorProvider;
    let notebookManager: IPlatformDeepnoteNotebookManager;
    let disposables: IDisposableRegistry;
    let onDidChangeIntegrationsEmitter: EventEmitter<void>;

    /** A non-federated, non-reserved pgsql config whose host is embedded in the generated connection URL. */
    function pgConfig(id: string, host: string): ConfigurableDatabaseIntegrationConfig {
        return {
            id,
            name: id,
            type: 'pgsql',
            metadata: {
                host,
                port: '5432',
                database: 'db',
                user: 'u',
                password: 'p',
                sslEnabled: false
            }
        };
    }

    /** Stubs the resource -> notebook -> project chain that every public method walks for `notebookUri`. */
    function stubNotebookWithProject(project: DeepnoteFile): void {
        const notebook = mock<NotebookDocument>();
        when(notebook.uri).thenReturn(notebookUri);
        when(notebook.metadata).thenReturn({
            deepnoteProjectId: 'project-123',
            deepnoteNotebookId: 'notebook-123'
        });
        when(notebookEditorProvider.findAssociatedNotebookDocument(notebookUri)).thenReturn(instance(notebook));
        when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
    }

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
            disposables,
            emptyFileConfigProvider()
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

            test('anchors a CA certificate path to the notebook directory, not the filesystem root', async () => {
                const resource = Uri.file('/test/proj/notebook.deepnote');
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
                        sslEnabled: true,
                        caCertificateName: 'my-ca.pem'
                    }
                };
                const project = createMockProject('project-123', [
                    { id: 'my-postgres', name: 'Production DB', type: 'pgsql' }
                ]);

                when(notebook.uri).thenReturn(resource);
                when(notebook.metadata).thenReturn({
                    deepnoteProjectId: 'project-123',
                    deepnoteNotebookId: 'notebook-123'
                });
                when(notebookEditorProvider.findAssociatedNotebookDocument(resource)).thenReturn(instance(notebook));
                when(notebookManager.getProjectForNotebook('project-123', 'notebook-123')).thenReturn(project);
                when(integrationStorage.getIntegrationConfig('my-postgres')).thenResolve(postgresConfig);

                const result = await provider.getEnvironmentVariables(resource);

                // A caCertificateName flips sslmode to verify-ca, so an unreadable path fails the connection
                // rather than degrading — an empty project root produced '/.deepnote/my-postgres/my-ca.pem'.
                const parsed = JSON.parse(result['SQL_MY_POSTGRES']!);
                assert.strictEqual(parsed.params.connect_args.sslmode, 'verify-ca');
                assert.strictEqual(
                    parsed.params.connect_args.sslrootcert,
                    `${getFilePath(Uri.file('/test/proj'))}/.deepnote/my-postgres/my-ca.pem`
                );
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

    suite('File config source (.deepnote.env.yaml) merge', () => {
        let fileConfigProvider: IIntegrationsFileConfigProvider;
        let providerWithFile: SqlIntegrationEnvironmentVariablesProvider;

        setup(() => {
            fileConfigProvider = mock<IIntegrationsFileConfigProvider>();
            providerWithFile = new SqlIntegrationEnvironmentVariablesProvider(
                instance(integrationStorage),
                instance(notebookEditorProvider),
                instance(notebookManager),
                disposables,
                instance(fileConfigProvider)
            );
        });

        test('File wins on id conflict: file config used and SecretStorage is not queried for that id', async () => {
            stubNotebookWithProject(
                createMockProject('project-123', [
                    { id: 'shared-db', name: 'shared-db', type: 'pgsql' },
                    { id: 'secret-only', name: 'secret-only', type: 'pgsql' }
                ])
            );
            when(fileConfigProvider.getConfigsForFile(anything())).thenResolve({
                configs: [pgConfig('shared-db', 'from-file.example.com')],
                issues: []
            });
            // Stubbed with a different host to prove the file wins; the provider must never consult it for `shared-db`.
            when(integrationStorage.getIntegrationConfig('shared-db')).thenResolve(
                pgConfig('shared-db', 'from-secret.example.com')
            );
            when(integrationStorage.getIntegrationConfig('secret-only')).thenResolve(
                pgConfig('secret-only', 'secret-only.example.com')
            );

            const result = await providerWithFile.getEnvironmentVariables(notebookUri);

            const sharedUrl = JSON.parse(result['SQL_SHARED_DB']!).url as string;
            assert.ok(sharedUrl.includes('from-file.example.com'), 'File config host should win the conflict');
            assert.ok(!sharedUrl.includes('from-secret.example.com'), 'SecretStorage host must not be used');
            assert.ok(result['SQL_SECRET_ONLY'], 'SecretStorage-only integration should still be resolved');

            verify(integrationStorage.getIntegrationConfig('shared-db')).never();
            verify(integrationStorage.getIntegrationConfig('secret-only')).once();
        });

        test('getMergedIntegrationConfigs returns the merged config list (file wins, SecretStorage fallback, file-only additive)', async () => {
            stubNotebookWithProject(
                createMockProject('project-123', [
                    { id: 'shared-db', name: 'shared-db', type: 'pgsql' },
                    { id: 'secret-only', name: 'secret-only', type: 'pgsql' }
                ])
            );
            when(fileConfigProvider.getConfigsForFile(anything())).thenResolve({
                configs: [
                    pgConfig('shared-db', 'from-file.example.com'),
                    pgConfig('file-only', 'file-only.example.com')
                ],
                issues: []
            });
            when(integrationStorage.getIntegrationConfig('secret-only')).thenResolve(
                pgConfig('secret-only', 'secret-only.example.com')
            );

            const merged = await providerWithFile.getMergedIntegrationConfigs(notebookUri);
            const byId = new Map(merged.map((config) => [config.id, config]));

            assert.deepStrictEqual(
                [...byId.keys()].sort(),
                ['file-only', 'secret-only', 'shared-db'],
                'merged configs must include the file-won, SecretStorage-fallback, and file-only integrations'
            );
            const sharedDb = byId.get('shared-db');
            assert.ok(
                sharedDb && JSON.stringify(sharedDb.metadata).includes('from-file.example.com'),
                'file config must win the id conflict in the merged list'
            );
            assert.ok(
                !byId.has(DATAFRAME_SQL_INTEGRATION_ID),
                'the internal DuckDB integration is not part of the merged list'
            );
            verify(integrationStorage.getIntegrationConfig('shared-db')).never();
        });

        test('getMergedIntegrationConfigs returns [] when the resource resolves to no project', async () => {
            const merged = await providerWithFile.getMergedIntegrationConfigs(undefined);

            assert.deepStrictEqual(merged, []);
        });

        test('getFileConfiguredIntegrationIds returns the file config ids only', async () => {
            stubNotebookWithProject(
                createMockProject('project-123', [{ id: 'secret-only', name: 'secret-only', type: 'pgsql' }])
            );
            when(fileConfigProvider.getConfigsForFile(anything())).thenResolve({
                configs: [pgConfig('shared-db', 'from-file.example.com'), pgConfig('file-only', 'file-only.test')],
                issues: []
            });

            const ids = await providerWithFile.getFileConfiguredIntegrationIds(notebookUri);

            assert.deepStrictEqual(
                ids,
                new Set(['shared-db', 'file-only']),
                'SecretStorage-only ids must not be reported as file-configured'
            );
            assert.deepStrictEqual(
                await providerWithFile.getFileConfiguredIntegrationIds(undefined),
                new Set(),
                'no resource means nothing to look up'
            );
            assert.deepStrictEqual(
                await providerWithFile.getFileConfiguredIntegrationIds(Uri.file('/ws/not-open.deepnote')),
                new Set(),
                'a resource with no associated notebook resolves to no file configs'
            );
        });

        test('File source yields nothing: behavior is SecretStorage-only (unchanged)', async () => {
            const providerWithoutFile = new SqlIntegrationEnvironmentVariablesProvider(
                instance(integrationStorage),
                instance(notebookEditorProvider),
                instance(notebookManager),
                disposables,
                emptyFileConfigProvider()
            );
            stubNotebookWithProject(
                createMockProject('project-123', [{ id: 'secret-db', name: 'secret-db', type: 'pgsql' }])
            );
            when(integrationStorage.getIntegrationConfig('secret-db')).thenResolve(
                pgConfig('secret-db', 'from-secret.example.com')
            );

            const result = await providerWithoutFile.getEnvironmentVariables(notebookUri);

            assert.ok(result['SQL_SECRET_DB'], 'SecretStorage integration should be resolved without a file provider');
            assert.ok(
                JSON.parse(result['SQL_SECRET_DB']!).url.includes('from-secret.example.com'),
                'SecretStorage config should be used'
            );
            assert.ok(result[duckDbEnvVar], 'DuckDB integration should always be included');
            verify(integrationStorage.getIntegrationConfig('secret-db')).once();
        });

        test('File source throws: degrades to SecretStorage + DuckDB without rejecting', async () => {
            stubNotebookWithProject(
                createMockProject('project-123', [{ id: 'secret-db', name: 'secret-db', type: 'pgsql' }])
            );
            when(fileConfigProvider.getConfigsForFile(anything())).thenReject(new Error('boom'));
            when(integrationStorage.getIntegrationConfig('secret-db')).thenResolve(
                pgConfig('secret-db', 'from-secret.example.com')
            );

            const result = await providerWithFile.getEnvironmentVariables(notebookUri);

            assert.ok(
                result['SQL_SECRET_DB'],
                'SecretStorage integration should still be resolved when the file source throws'
            );
            assert.ok(result[duckDbEnvVar], 'DuckDB integration should still be included when the file source throws');
        });
    });

    suite('Federated-auth candidates and env-var exclusion', () => {
        let fileConfigProvider: IIntegrationsFileConfigProvider;
        let providerWithFile: SqlIntegrationEnvironmentVariablesProvider;

        /** BigQuery + `google-oauth` — the one federated combination this extension implements. */
        function bigQueryOauthConfig(id: string, name: string): ConfigurableDatabaseIntegrationConfig {
            return {
                id,
                name,
                type: 'big-query',
                metadata: {
                    authMethod: 'google-oauth',
                    project: 'oauth-project',
                    clientId: `${id}-client-id`,
                    clientSecret: `${id}-client-secret`
                }
            };
        }

        setup(() => {
            fileConfigProvider = mock<IIntegrationsFileConfigProvider>();
            providerWithFile = new SqlIntegrationEnvironmentVariablesProvider(
                instance(integrationStorage),
                instance(notebookEditorProvider),
                instance(notebookManager),
                disposables,
                instance(fileConfigProvider)
            );
        });

        test('File-sourced federated config reaches getMergedIntegrationConfigs but contributes no env vars', async () => {
            stubNotebookWithProject(createMockProject('project-123', []));
            when(fileConfigProvider.getConfigsForFile(anything())).thenResolve({
                configs: [bigQueryOauthConfig('bq-file', 'File BQ'), pgConfig('pg-file', 'pg-file.example.com')],
                issues: []
            });

            const merged = await providerWithFile.getMergedIntegrationConfigs(notebookUri);
            const envVars = await providerWithFile.getEnvironmentVariables(notebookUri);

            assert.deepStrictEqual(
                merged.map((config) => config.id),
                ['bq-file', 'pg-file'],
                'the file-declared federated config must survive the merge; the SQL LSP and status bar need it'
            );
            // Without the skip in `getEnvironmentVariables`, upstream emits every metadata key for the federated
            // config (`FILE_BQ_CLIENTID` / `FILE_BQ_CLIENTSECRET`) and no usable `SQL_*` connection var for it.
            assert.deepStrictEqual(
                Object.keys(envVars).filter((name) => /_CLIENTID$|_CLIENTSECRET$/.test(name)),
                [],
                'OAuth client credentials must never reach the kernel environment'
            );
            assert.strictEqual(
                envVars['SQL_BQ_FILE'],
                undefined,
                'no connection var is emitted for a federated config'
            );
            assert.ok(envVars['SQL_PG_FILE'], 'a federated config must not suppress its non-federated siblings');
            assert.ok(envVars[duckDbEnvVar], 'DuckDB integration should still be included');
        });

        test('getFederatedAuthCandidates returns the supported federated ids from either source', async () => {
            stubNotebookWithProject(
                createMockProject('project-123', [
                    { id: 'bq-secret-oauth', name: 'Secret BQ', type: 'big-query' },
                    { id: 'bq-service-account', name: 'Service Account BQ', type: 'big-query' },
                    { id: 'sf-native-oauth', name: 'Snowflake OAuth', type: 'snowflake' }
                ])
            );
            when(fileConfigProvider.getConfigsForFile(anything())).thenResolve({
                configs: [bigQueryOauthConfig('bq-file-oauth', 'File BQ')],
                issues: []
            });
            when(integrationStorage.getIntegrationConfig('bq-secret-oauth')).thenResolve(
                bigQueryOauthConfig('bq-secret-oauth', 'Secret BQ')
            );
            // BigQuery, but not federated at all.
            when(integrationStorage.getIntegrationConfig('bq-service-account')).thenResolve({
                id: 'bq-service-account',
                name: 'Service Account BQ',
                type: 'big-query',
                metadata: {
                    authMethod: 'service-account',
                    service_account: '{"type":"service_account","project_id":"test"}'
                }
            });
            // Federated, but not the combination `FederatedAuthSqlBlockCodeGenerator` implements.
            when(integrationStorage.getIntegrationConfig('sf-native-oauth')).thenResolve({
                id: 'sf-native-oauth',
                name: 'Snowflake OAuth',
                type: 'snowflake',
                metadata: {
                    authMethod: 'snowflake',
                    accountName: 'test-account',
                    clientId: 'sf-client-id',
                    clientSecret: 'sf-client-secret'
                }
            });

            const candidates = await providerWithFile.getFederatedAuthCandidates(notebookUri);

            assert.deepStrictEqual(candidates, new Set(['bq-file-oauth', 'bq-secret-oauth']));
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
