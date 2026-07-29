import { BigQueryAuthMethods } from '@deepnote/database-integrations';
import { assert } from 'chai';

import { supportedSqlLspTypes, isSupportedBySqlLsp, convertToSqlLspConnection } from './sqlLspConnectionUtils';
import { ConfigurableDatabaseIntegrationConfig } from '../../platform/notebooks/deepnote/integrationTypes';

/**
 * Helper to create test configs with any metadata shape
 */
function createTestConfig(
    type: string,
    name: string,
    metadata: Record<string, any>
): ConfigurableDatabaseIntegrationConfig {
    return { type, name, metadata } as ConfigurableDatabaseIntegrationConfig;
}

suite('SQL LSP Connection Utils Unit Tests', () => {
    suite('isSupportedBySqlLsp', () => {
        test('should return true for PostgreSQL (pgsql)', () => {
            assert.isTrue(isSupportedBySqlLsp('pgsql'));
        });

        test('should return true for MySQL', () => {
            assert.isTrue(isSupportedBySqlLsp('mysql'));
        });

        test('should return true for BigQuery (big-query)', () => {
            assert.isTrue(isSupportedBySqlLsp('big-query'));
        });

        test('should return false for unsupported types', () => {
            assert.isFalse(isSupportedBySqlLsp('sqlite'));
            assert.isFalse(isSupportedBySqlLsp('mongodb'));
            assert.isFalse(isSupportedBySqlLsp('redis'));
            assert.isFalse(isSupportedBySqlLsp(''));
        });
    });

    suite('convertToSqlLspConnection', () => {
        suite('PostgreSQL conversion', () => {
            test('should convert pgsql config with all fields', () => {
                const config = createTestConfig('pgsql', 'My Postgres', {
                    host: 'db.example.com',
                    port: '5433',
                    username: 'admin',
                    password: 'secret123',
                    database: 'mydb'
                });

                const result = convertToSqlLspConnection(config);

                assert.deepStrictEqual(result, {
                    name: 'My Postgres',
                    adapter: 'postgres',
                    host: 'db.example.com',
                    port: 5433,
                    user: 'admin',
                    password: 'secret123',
                    database: 'mydb'
                });
            });

            test('should use default values for missing fields', () => {
                const config = createTestConfig('pgsql', '', {});

                const result = convertToSqlLspConnection(config);

                assert.deepStrictEqual(result, {
                    name: 'postgres',
                    adapter: 'postgres',
                    host: 'localhost',
                    port: 5432,
                    user: undefined,
                    password: undefined,
                    database: undefined
                });
            });

            test('should handle alternative field names (user, dbname)', () => {
                const config = createTestConfig('pgsql', 'Alt Fields', {
                    host: 'localhost',
                    port: 5432,
                    user: 'altuser',
                    password: 'pass',
                    dbname: 'altdb'
                });

                const result = convertToSqlLspConnection(config);

                assert.strictEqual(result?.user, 'altuser');
                assert.strictEqual(result?.database, 'altdb');
            });

            test('should convert string port to number', () => {
                const config = createTestConfig('pgsql', 'String Port', {
                    port: '5432'
                });

                const result = convertToSqlLspConnection(config);

                assert.strictEqual(result?.port, 5432);
                assert.strictEqual(typeof result?.port, 'number');
            });
        });

        suite('MySQL conversion', () => {
            test('should convert mysql config with all fields', () => {
                const config = createTestConfig('mysql', 'My MySQL', {
                    host: 'mysql.example.com',
                    port: '3307',
                    username: 'root',
                    password: 'rootpass',
                    database: 'testdb'
                });

                const result = convertToSqlLspConnection(config);

                assert.deepStrictEqual(result, {
                    name: 'My MySQL',
                    adapter: 'mysql',
                    host: 'mysql.example.com',
                    port: 3307,
                    user: 'root',
                    password: 'rootpass',
                    database: 'testdb'
                });
            });

            test('should use default MySQL port 3306', () => {
                const config = createTestConfig('mysql', 'Default Port', {});

                const result = convertToSqlLspConnection(config);

                assert.strictEqual(result?.port, 3306);
            });
        });

        suite('BigQuery conversion', () => {
            test('should convert big-query config with all fields', () => {
                const config = createTestConfig('big-query', 'My BigQuery', {
                    projectId: 'my-gcp-project',
                    keyFilename: '/path/to/key.json'
                });

                const result = convertToSqlLspConnection(config);

                assert.deepStrictEqual(result, {
                    name: 'My BigQuery',
                    adapter: 'bigquery',
                    projectId: 'my-gcp-project',
                    keyFilename: '/path/to/key.json'
                });
            });

            test('should handle alternative field names (project_id, key_filename)', () => {
                const config = createTestConfig('big-query', 'Alt BigQuery', {
                    project_id: 'alt-project',
                    key_filename: '/alt/path.json'
                });

                const result = convertToSqlLspConnection(config);

                assert.strictEqual(result?.projectId, 'alt-project');
                assert.strictEqual(result?.keyFilename, '/alt/path.json');
            });

            test('should convert service account big-query config', () => {
                const config = createTestConfig('big-query', 'Service Account BigQuery', {
                    authMethod: BigQueryAuthMethods.ServiceAccount,
                    projectId: 'sa-project',
                    keyFilename: '/sa/key.json'
                });

                const result = convertToSqlLspConnection(config);

                assert.deepStrictEqual(result, {
                    name: 'Service Account BigQuery',
                    adapter: 'bigquery',
                    projectId: 'sa-project',
                    keyFilename: '/sa/key.json'
                });
            });

            test('should return null for federated (google-oauth) big-query config', () => {
                const config = createTestConfig('big-query', 'Federated BigQuery', {
                    authMethod: BigQueryAuthMethods.GoogleOauth,
                    project: 'federated-project',
                    clientId: 'client-id',
                    clientSecret: 'client-secret'
                });

                const result = convertToSqlLspConnection(config);

                assert.isNull(result);
            });
        });

        suite('Unsupported types', () => {
            test('should return null for unsupported database types', () => {
                const config = createTestConfig('mongodb', 'Mongo', {});

                const result = convertToSqlLspConnection(config);

                assert.isNull(result);
            });

            test('should return null for empty type', () => {
                const config = createTestConfig('', 'Empty Type', {});

                const result = convertToSqlLspConnection(config);

                assert.isNull(result);
            });
        });

        suite('Error handling', () => {
            test('should return null and not throw on invalid config', () => {
                const config = {
                    type: 'pgsql',
                    name: 'Invalid'
                    // Missing metadata entirely
                } as ConfigurableDatabaseIntegrationConfig;

                // Should not throw
                const result = convertToSqlLspConnection(config);

                // Behavior depends on implementation - either null or partial result
                // The important thing is it doesn't crash
                assert.ok(result === null || typeof result === 'object');
            });
        });
    });

    suite('SUPPORTED_SQL_LSP_TYPES constant', () => {
        test('should contain all supported database types', () => {
            assert.include(supportedSqlLspTypes, 'mysql');
            assert.include(supportedSqlLspTypes, 'pgsql');
            assert.include(supportedSqlLspTypes, 'big-query');
        });

        test('should have exactly 3 supported types', () => {
            assert.strictEqual(supportedSqlLspTypes.length, 3);
        });
    });
});
