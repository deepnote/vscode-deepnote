import { assert } from 'chai';
import { anything, instance, mock, when, verify, deepEqual } from 'ts-mockito';
import { Uri } from 'vscode';
import { DeepnoteConfigurationManager } from './deepnoteConfigurationManager';
import { DeepnoteConfigurationStorage } from './deepnoteConfigurationStorage';
import { IExtensionContext } from '../../../platform/common/types';
import { IDeepnoteServerStarter, IDeepnoteToolkitInstaller, DeepnoteServerInfo } from '../types';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { KernelConfigurationStatus } from './deepnoteKernelConfiguration';

suite('DeepnoteConfigurationManager', () => {
    let manager: DeepnoteConfigurationManager;
    let mockContext: IExtensionContext;
    let mockStorage: DeepnoteConfigurationStorage;
    let mockToolkitInstaller: IDeepnoteToolkitInstaller;
    let mockServerStarter: IDeepnoteServerStarter;

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3'),
        version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
    } as PythonEnvironment;

    const testServerInfo: DeepnoteServerInfo = {
        url: 'http://localhost:8888',
        port: 8888,
        token: 'test-token'
    };

    setup(() => {
        mockContext = mock<IExtensionContext>();
        mockStorage = mock<DeepnoteConfigurationStorage>();
        mockToolkitInstaller = mock<IDeepnoteToolkitInstaller>();
        mockServerStarter = mock<IDeepnoteServerStarter>();

        when(mockContext.globalStorageUri).thenReturn(Uri.file('/global/storage'));
        when(mockStorage.loadConfigurations()).thenResolve([]);

        manager = new DeepnoteConfigurationManager(
            instance(mockContext),
            instance(mockStorage),
            instance(mockToolkitInstaller),
            instance(mockServerStarter)
        );
    });

    suite('activate', () => {
        test('should load configurations on activation', async () => {
            const existingConfigs = [
                {
                    id: 'existing-config',
                    name: 'Existing',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/path/to/venv'),
                    createdAt: new Date(),
                    lastUsedAt: new Date()
                }
            ];

            when(mockStorage.loadConfigurations()).thenResolve(existingConfigs);

            manager.activate();
            // Wait for async initialization
            await new Promise((resolve) => setTimeout(resolve, 100));

            const configs = manager.listConfigurations();
            assert.strictEqual(configs.length, 1);
            assert.strictEqual(configs[0].id, 'existing-config');
        });
    });

    suite('createConfiguration', () => {
        test('should create a new configuration', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test Config',
                pythonInterpreter: testInterpreter,
                packages: ['numpy'],
                description: 'Test description'
            });

            assert.strictEqual(config.name, 'Test Config');
            assert.strictEqual(config.pythonInterpreter, testInterpreter);
            assert.deepStrictEqual(config.packages, ['numpy']);
            assert.strictEqual(config.description, 'Test description');
            assert.ok(config.id);
            assert.ok(config.venvPath);
            assert.ok(config.createdAt);
            assert.ok(config.lastUsedAt);

            verify(mockStorage.saveConfigurations(anything())).once();
        });

        test('should generate unique IDs for each configuration', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config1 = await manager.createConfiguration({
                name: 'Config 1',
                pythonInterpreter: testInterpreter
            });

            const config2 = await manager.createConfiguration({
                name: 'Config 2',
                pythonInterpreter: testInterpreter
            });

            assert.notEqual(config1.id, config2.id);
        });

        test('should fire onDidChangeConfigurations event', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            let eventFired = false;
            manager.onDidChangeConfigurations(() => {
                eventFired = true;
            });

            await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            assert.isTrue(eventFired);
        });
    });

    suite('listConfigurations', () => {
        test('should return empty array initially', () => {
            const configs = manager.listConfigurations();
            assert.deepStrictEqual(configs, []);
        });

        test('should return all created configurations', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            await manager.createConfiguration({ name: 'Config 1', pythonInterpreter: testInterpreter });
            await manager.createConfiguration({ name: 'Config 2', pythonInterpreter: testInterpreter });

            const configs = manager.listConfigurations();
            assert.strictEqual(configs.length, 2);
        });
    });

    suite('getConfiguration', () => {
        test('should return undefined for non-existent ID', () => {
            const config = manager.getConfiguration('non-existent');
            assert.isUndefined(config);
        });

        test('should return configuration by ID', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const created = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            const found = manager.getConfiguration(created.id);
            assert.strictEqual(found?.id, created.id);
            assert.strictEqual(found?.name, 'Test');
        });
    });

    suite('getConfigurationWithStatus', () => {
        test('should return configuration with stopped status when server is not running', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const created = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            const withStatus = manager.getConfigurationWithStatus(created.id);
            assert.strictEqual(withStatus?.status, KernelConfigurationStatus.Stopped);
        });

        test('should return configuration with running status when server is running', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );

            const created = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.startServer(created.id);

            const withStatus = manager.getConfigurationWithStatus(created.id);
            assert.strictEqual(withStatus?.status, KernelConfigurationStatus.Running);
        });
    });

    suite('updateConfiguration', () => {
        test('should update configuration name', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Original Name',
                pythonInterpreter: testInterpreter
            });

            await manager.updateConfiguration(config.id, { name: 'Updated Name' });

            const updated = manager.getConfiguration(config.id);
            assert.strictEqual(updated?.name, 'Updated Name');
        });

        test('should update packages', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter,
                packages: ['numpy']
            });

            await manager.updateConfiguration(config.id, { packages: ['numpy', 'pandas'] });

            const updated = manager.getConfiguration(config.id);
            assert.deepStrictEqual(updated?.packages, ['numpy', 'pandas']);
        });

        test('should throw error for non-existent configuration', async () => {
            await assert.isRejected(
                manager.updateConfiguration('non-existent', { name: 'Test' }),
                'Configuration not found: non-existent'
            );
        });

        test('should fire onDidChangeConfigurations event', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            let eventFired = false;
            manager.onDidChangeConfigurations(() => {
                eventFired = true;
            });

            await manager.updateConfiguration(config.id, { name: 'Updated' });

            assert.isTrue(eventFired);
        });
    });

    suite('deleteConfiguration', () => {
        test('should delete configuration', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.deleteConfiguration(config.id);

            const deleted = manager.getConfiguration(config.id);
            assert.isUndefined(deleted);
        });

        test('should stop server before deleting if running', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );
            when(mockServerStarter.stopServer(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.startServer(config.id);
            await manager.deleteConfiguration(config.id);

            verify(mockServerStarter.stopServer(config.id)).once();
        });

        test('should throw error for non-existent configuration', async () => {
            await assert.isRejected(
                manager.deleteConfiguration('non-existent'),
                'Configuration not found: non-existent'
            );
        });
    });

    suite('startServer', () => {
        test('should start server for configuration', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.startServer(config.id);

            const updated = manager.getConfiguration(config.id);
            assert.deepStrictEqual(updated?.serverInfo, testServerInfo);

            verify(mockToolkitInstaller.ensureVenvAndToolkit(testInterpreter, anything(), anything())).once();
            verify(mockServerStarter.startServer(testInterpreter, anything(), config.id, anything())).once();
        });

        test('should install additional packages when specified', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockToolkitInstaller.installAdditionalPackages(anything(), anything(), anything())).thenResolve();
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter,
                packages: ['numpy', 'pandas']
            });

            await manager.startServer(config.id);

            verify(
                mockToolkitInstaller.installAdditionalPackages(anything(), deepEqual(['numpy', 'pandas']), anything())
            ).once();
        });

        test('should not start if server is already running', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.startServer(config.id);
            await manager.startServer(config.id);

            // Should only call once
            verify(mockServerStarter.startServer(anything(), anything(), anything(), anything())).once();
        });

        test('should update lastUsedAt timestamp', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            const originalLastUsed = config.lastUsedAt;
            await new Promise((resolve) => setTimeout(resolve, 10));
            await manager.startServer(config.id);

            const updated = manager.getConfiguration(config.id);
            assert.isTrue(updated!.lastUsedAt > originalLastUsed);
        });

        test('should throw error for non-existent configuration', async () => {
            await assert.isRejected(manager.startServer('non-existent'), 'Configuration not found: non-existent');
        });
    });

    suite('stopServer', () => {
        test('should stop running server', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );
            when(mockServerStarter.stopServer(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.startServer(config.id);
            await manager.stopServer(config.id);

            const updated = manager.getConfiguration(config.id);
            assert.isUndefined(updated?.serverInfo);

            verify(mockServerStarter.stopServer(config.id)).once();
        });

        test('should do nothing if server is not running', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.stopServer(config.id);

            verify(mockServerStarter.stopServer(anything())).never();
        });

        test('should throw error for non-existent configuration', async () => {
            await assert.isRejected(manager.stopServer('non-existent'), 'Configuration not found: non-existent');
        });
    });

    suite('restartServer', () => {
        test('should stop and start server', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();
            when(mockToolkitInstaller.ensureVenvAndToolkit(anything(), anything(), anything())).thenResolve(
                testInterpreter
            );
            when(mockServerStarter.startServer(anything(), anything(), anything(), anything())).thenResolve(
                testServerInfo
            );
            when(mockServerStarter.stopServer(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.startServer(config.id);
            await manager.restartServer(config.id);

            verify(mockServerStarter.stopServer(config.id)).once();
            // Called twice: once for initial start, once for restart
            verify(mockServerStarter.startServer(anything(), anything(), anything(), anything())).twice();
        });
    });

    suite('updateLastUsed', () => {
        test('should update lastUsedAt timestamp', async () => {
            when(mockStorage.saveConfigurations(anything())).thenResolve();

            const config = await manager.createConfiguration({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            const originalLastUsed = config.lastUsedAt;
            await new Promise((resolve) => setTimeout(resolve, 10));
            await manager.updateLastUsed(config.id);

            const updated = manager.getConfiguration(config.id);
            assert.isTrue(updated!.lastUsedAt > originalLastUsed);
        });

        test('should do nothing for non-existent configuration', async () => {
            await manager.updateLastUsed('non-existent');
            // Should not throw
        });
    });

    suite('dispose', () => {
        test('should dispose event emitter', () => {
            manager.dispose();
            // Should not throw
        });
    });
});
