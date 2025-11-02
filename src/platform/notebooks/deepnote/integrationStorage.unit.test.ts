import assert from 'assert';
import { anything, instance, mock, when } from 'ts-mockito';

import { IEncryptedStorage } from '../../common/application/types';
import { IAsyncDisposableRegistry } from '../../common/types';
import { IntegrationStorage } from './integrationStorage';
import { DatabaseIntegrationConfig } from '@deepnote/database-integrations';
import { DATAFRAME_SQL_INTEGRATION_ID } from './integrationTypes';

suite('IntegrationStorage', () => {
    let storage: IntegrationStorage;
    let encryptedStorage: IEncryptedStorage;
    let asyncRegistry: IAsyncDisposableRegistry;
    let storageData: Map<string, string | undefined>;

    setup(() => {
        // Create a mock encrypted storage with in-memory data
        storageData = new Map();
        encryptedStorage = mock<IEncryptedStorage>();
        asyncRegistry = mock<IAsyncDisposableRegistry>();

        // Mock the store and retrieve methods to use our in-memory map
        when(encryptedStorage.store(anything(), anything(), anything())).thenCall(
            async (_serviceName: string, key: string, value: string | undefined) => {
                if (value === undefined) {
                    storageData.delete(key);
                } else {
                    storageData.set(key, value);
                }
            }
        );

        when(encryptedStorage.retrieve(anything(), anything())).thenCall(async (_serviceName: string, key: string) => {
            return storageData.get(key);
        });

        storage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));
    });

    teardown(() => {
        storage.dispose();
    });

    suite('getAll', () => {
        test('Returns empty array when no integrations are stored', async () => {
            const result = await storage.getAll();
            assert.deepStrictEqual(result, []);
        });

        test('Returns all stored integrations', async () => {
            const config1: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            const config2: DatabaseIntegrationConfig = {
                id: 'bigquery-1',
                name: 'My BigQuery',
                type: 'big-query',
                metadata: {
                    authMethod: 'service-account',
                    service_account: '{"type":"service_account","project_id":"test"}'
                }
            };

            await storage.save(config1);
            await storage.save(config2);

            const result = await storage.getAll();
            assert.strictEqual(result.length, 2);
            assert.ok(result.find((c) => c.id === 'postgres-1'));
            assert.ok(result.find((c) => c.id === 'bigquery-1'));
        });
    });

    suite('getIntegrationConfig', () => {
        test('Returns undefined when integration does not exist', async () => {
            const result = await storage.getIntegrationConfig('non-existent');
            assert.strictEqual(result, undefined);
        });

        test('Returns the integration config when it exists', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            await storage.save(config);
            const result = await storage.getIntegrationConfig('postgres-1');

            assert.ok(result);
            assert.strictEqual(result.id, 'postgres-1');
            assert.strictEqual(result.name, 'My Postgres');
            assert.strictEqual(result.type, 'pgsql');
        });
    });

    suite('getProjectIntegrationConfig', () => {
        test('Returns the same result as getIntegrationConfig (ignores projectId)', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            await storage.save(config);
            const result = await storage.getProjectIntegrationConfig('any-project-id', 'postgres-1');

            assert.ok(result);
            assert.strictEqual(result.id, 'postgres-1');
        });
    });

    suite('save', () => {
        test('Saves a new integration config', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            await storage.save(config);
            const result = await storage.getIntegrationConfig('postgres-1');

            assert.ok(result);
            assert.strictEqual(result.id, 'postgres-1');
        });

        test('Updates an existing integration config', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            await storage.save(config);

            const updatedConfig: DatabaseIntegrationConfig = {
                ...config,
                name: 'Updated Postgres'
            };

            await storage.save(updatedConfig);
            const result = await storage.getIntegrationConfig('postgres-1');

            assert.ok(result);
            assert.strictEqual(result.name, 'Updated Postgres');
        });

        test('Does not save pandas-dataframe type integrations', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'dataframe-1',
                name: 'DataFrame',
                type: 'pandas-dataframe',
                metadata: {}
            };

            await storage.save(config);
            const result = await storage.getIntegrationConfig('dataframe-1');

            assert.strictEqual(result, undefined);
        });

        test('Does not save DATAFRAME_SQL_INTEGRATION_ID', async () => {
            const config: DatabaseIntegrationConfig = {
                id: DATAFRAME_SQL_INTEGRATION_ID,
                name: 'DuckDB',
                type: 'pandas-dataframe',
                metadata: {}
            };

            await storage.save(config);
            const result = await storage.getIntegrationConfig(DATAFRAME_SQL_INTEGRATION_ID);

            assert.strictEqual(result, undefined);
        });

        test('Fires onDidChangeIntegrations event when saving', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            let eventCount = 0;
            storage.onDidChangeIntegrations(() => {
                eventCount++;
            });

            await storage.save(config);
            assert.strictEqual(eventCount, 1);
        });
    });

    suite('delete', () => {
        test('Deletes an existing integration', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            await storage.save(config);
            await storage.delete('postgres-1');
            const result = await storage.getIntegrationConfig('postgres-1');

            assert.strictEqual(result, undefined);
        });

        test('Fires onDidChangeIntegrations event when deleting', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            let eventCount = 0;
            storage.onDidChangeIntegrations(() => {
                eventCount++;
            });

            await storage.save(config).then(() => storage.delete('postgres-1'));
            assert.strictEqual(eventCount, 2);
        });
    });

    suite('exists', () => {
        test('Returns false when integration does not exist', async () => {
            const result = await storage.exists('non-existent');
            assert.strictEqual(result, false);
        });

        test('Returns true when integration exists', async () => {
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            await storage.save(config);
            const result = await storage.exists('postgres-1');
            assert.strictEqual(result, true);
        });
    });

    suite('clear', () => {
        test('Clears all integrations', async () => {
            const config1: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            const config2: DatabaseIntegrationConfig = {
                id: 'bigquery-1',
                name: 'My BigQuery',
                type: 'big-query',
                metadata: {
                    authMethod: 'service-account',
                    service_account: '{"type":"service_account","project_id":"test"}'
                }
            };

            await storage.save(config1);
            await storage.save(config2);
            await storage.clear();

            const result = await storage.getAll();
            assert.deepStrictEqual(result, []);
        });

        test('Fires onDidChangeIntegrations event when clearing', async () => {
            let eventCount = 0;
            storage.onDidChangeIntegrations(() => {
                eventCount++;
            });

            await storage.clear();
            assert.strictEqual(eventCount, 1);
        });
    });

    suite('Loading from encrypted storage', () => {
        test('Loads valid integration configs from storage on first access', async () => {
            // Manually populate the storage with valid configs
            const config: DatabaseIntegrationConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
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

            storageData.set('index', JSON.stringify(['postgres-1']));
            storageData.set('postgres-1', JSON.stringify({ ...config, version: 1 }));

            // Create a new storage instance to test loading
            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const result = await newStorage.getIntegrationConfig('postgres-1');
            assert.ok(result);
            assert.strictEqual(result.id, 'postgres-1');
            assert.strictEqual(result.name, 'My Postgres');

            newStorage.dispose();
        });

        test('Skips DATAFRAME_SQL_INTEGRATION_ID when loading from storage', async () => {
            storageData.set('index', JSON.stringify([DATAFRAME_SQL_INTEGRATION_ID, 'postgres-1']));
            storageData.set(
                DATAFRAME_SQL_INTEGRATION_ID,
                JSON.stringify({
                    id: DATAFRAME_SQL_INTEGRATION_ID,
                    name: 'DuckDB',
                    type: 'pandas-dataframe',
                    metadata: {},
                    version: 1
                })
            );
            storageData.set(
                'postgres-1',
                JSON.stringify({
                    id: 'postgres-1',
                    name: 'My Postgres',
                    type: 'pgsql',
                    metadata: {
                        host: 'localhost',
                        port: '5432',
                        database: 'testdb',
                        user: 'testuser',
                        password: 'testpass',
                        sslEnabled: false
                    },
                    version: 1
                })
            );

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].id, 'postgres-1');

            const duckdb = await newStorage.getIntegrationConfig(DATAFRAME_SQL_INTEGRATION_ID);
            assert.strictEqual(duckdb, undefined);

            newStorage.dispose();
        });

        test('Filters out pandas-dataframe type integrations when loading', async () => {
            storageData.set('index', JSON.stringify(['dataframe-1', 'postgres-1']));
            storageData.set(
                'dataframe-1',
                JSON.stringify({
                    id: 'dataframe-1',
                    name: 'DataFrame',
                    type: 'pandas-dataframe',
                    metadata: {},
                    version: 1
                })
            );
            storageData.set(
                'postgres-1',
                JSON.stringify({
                    id: 'postgres-1',
                    name: 'My Postgres',
                    type: 'pgsql',
                    metadata: {
                        host: 'localhost',
                        port: '5432',
                        database: 'testdb',
                        user: 'testuser',
                        password: 'testpass',
                        sslEnabled: false
                    },
                    version: 1
                })
            );

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].id, 'postgres-1');

            newStorage.dispose();
        });

        test('Filters out invalid integration configs when loading', async () => {
            storageData.set('index', JSON.stringify(['invalid-1', 'postgres-1']));
            storageData.set(
                'invalid-1',
                JSON.stringify({
                    id: 'invalid-1',
                    name: 'Invalid',
                    type: 'unknown-type',
                    metadata: {},
                    version: 1
                })
            );
            storageData.set(
                'postgres-1',
                JSON.stringify({
                    id: 'postgres-1',
                    name: 'My Postgres',
                    type: 'pgsql',
                    metadata: {
                        host: 'localhost',
                        port: '5432',
                        database: 'testdb',
                        user: 'testuser',
                        password: 'testpass',
                        sslEnabled: false
                    },
                    version: 1
                })
            );

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].id, 'postgres-1');

            newStorage.dispose();
        });

        test('Filters out configs with invalid metadata when loading', async () => {
            storageData.set('index', JSON.stringify(['invalid-metadata', 'postgres-1']));
            storageData.set(
                'invalid-metadata',
                JSON.stringify({
                    id: 'invalid-metadata',
                    name: 'Invalid Metadata',
                    type: 'pgsql',
                    metadata: {
                        // Missing required fields like host, port, database, etc.
                        invalidField: 'value'
                    },
                    version: 1
                })
            );
            storageData.set(
                'postgres-1',
                JSON.stringify({
                    id: 'postgres-1',
                    name: 'My Postgres',
                    type: 'pgsql',
                    metadata: {
                        host: 'localhost',
                        port: '5432',
                        database: 'testdb',
                        user: 'testuser',
                        password: 'testpass',
                        sslEnabled: false
                    },
                    version: 1
                })
            );

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].id, 'postgres-1');

            newStorage.dispose();
        });

        test('Filters out configs with corrupted JSON when loading', async () => {
            storageData.set('index', JSON.stringify(['corrupted', 'postgres-1']));
            storageData.set('corrupted', 'invalid json {{{');
            storageData.set(
                'postgres-1',
                JSON.stringify({
                    id: 'postgres-1',
                    name: 'My Postgres',
                    type: 'pgsql',
                    metadata: {
                        host: 'localhost',
                        port: '5432',
                        database: 'testdb',
                        user: 'testuser',
                        password: 'testpass',
                        sslEnabled: false
                    },
                    version: 1
                })
            );

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.strictEqual(all.length, 1);
            assert.strictEqual(all[0].id, 'postgres-1');

            newStorage.dispose();
        });

        test('Handles empty index gracefully', async () => {
            storageData.set('index', JSON.stringify([]));

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.deepStrictEqual(all, []);

            newStorage.dispose();
        });

        test('Handles missing index gracefully', async () => {
            // Don't set any index

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.deepStrictEqual(all, []);

            newStorage.dispose();
        });

        test('Handles corrupted index JSON gracefully', async () => {
            storageData.set('index', 'invalid json {{{');

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.deepStrictEqual(all, []);

            newStorage.dispose();
        });

        test('Loads multiple valid integrations of different types', async () => {
            const postgresConfig = {
                id: 'postgres-1',
                name: 'My Postgres',
                type: 'pgsql',
                metadata: {
                    host: 'localhost',
                    port: '5432',
                    database: 'testdb',
                    user: 'testuser',
                    password: 'testpass',
                    sslEnabled: false
                },
                version: 1
            };

            const bigqueryConfig = {
                id: 'bigquery-1',
                name: 'My BigQuery',
                type: 'big-query',
                metadata: {
                    authMethod: 'service-account',
                    service_account: '{"type":"service_account","project_id":"test"}'
                },
                version: 1
            };

            const postgres2Config = {
                id: 'postgres-2',
                name: 'My Second Postgres',
                type: 'pgsql',
                metadata: {
                    host: 'remote.example.com',
                    port: '5433',
                    database: 'proddb',
                    user: 'produser',
                    password: 'prodpass',
                    sslEnabled: true
                },
                version: 1
            };

            storageData.set('index', JSON.stringify(['postgres-1', 'bigquery-1', 'postgres-2']));
            storageData.set('postgres-1', JSON.stringify(postgresConfig));
            storageData.set('bigquery-1', JSON.stringify(bigqueryConfig));
            storageData.set('postgres-2', JSON.stringify(postgres2Config));

            const newStorage = new IntegrationStorage(instance(encryptedStorage), instance(asyncRegistry));

            const all = await newStorage.getAll();
            assert.strictEqual(all.length, 3);

            const postgres1 = all.find((c) => c.id === 'postgres-1');
            const bigquery = all.find((c) => c.id === 'bigquery-1');
            const postgres2 = all.find((c) => c.id === 'postgres-2');

            assert.ok(postgres1);
            assert.strictEqual(postgres1.type, 'pgsql');

            assert.ok(bigquery);
            assert.strictEqual(bigquery.type, 'big-query');

            assert.ok(postgres2);
            assert.strictEqual(postgres2.type, 'pgsql');

            newStorage.dispose();
        });
    });
});
