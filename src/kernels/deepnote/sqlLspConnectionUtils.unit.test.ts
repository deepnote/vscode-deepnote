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
                    user: 'admin',
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
                    user: 'root',
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

        suite('BigQuery', () => {
            test('should return null for big-query (not converted to SQL LSP connection)', () => {
                const config = createTestConfig('big-query', 'My BigQuery', {
                    projectId: 'my-gcp-project',
                    keyFilename: '/path/to/key.json'
                });

                const result = convertToSqlLspConnection(config);

                assert.isNull(result);
            });
        });

        suite('Federated auth', () => {
            test('should return null for federated-auth metadata', () => {
                const config = createTestConfig('big-query', 'Federated BigQuery', {
                    authMethod: 'google-oauth'
                });

                const result = convertToSqlLspConnection(config);

                assert.isNull(result);
            });

            test('should return null for federated-auth pgsql metadata', () => {
                const config = createTestConfig('pgsql', 'Federated Postgres', {
                    authMethod: 'google-oauth',
                    host: 'db.example.com',
                    user: 'admin',
                    database: 'mydb'
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

                const result = convertToSqlLspConnection(config);

                assert.isNull(result);
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
