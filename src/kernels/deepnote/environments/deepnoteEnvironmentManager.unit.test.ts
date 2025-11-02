import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { anything, instance, mock, when, verify } from 'ts-mockito';
import { Uri } from 'vscode';
import { DeepnoteEnvironmentManager } from './deepnoteEnvironmentManager.node';
import { DeepnoteEnvironmentStorage } from './deepnoteEnvironmentStorage.node';
import { IExtensionContext, IOutputChannel } from '../../../platform/common/types';
import { IDeepnoteServerStarter } from '../types';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';

use(chaiAsPromised);

suite('DeepnoteEnvironmentManager', () => {
    let manager: DeepnoteEnvironmentManager;
    let mockContext: IExtensionContext;
    let mockStorage: DeepnoteEnvironmentStorage;
    let mockServerStarter: IDeepnoteServerStarter;
    let mockOutputChannel: IOutputChannel;

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3'),
        version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
    } as PythonEnvironment;

    setup(() => {
        mockContext = mock<IExtensionContext>();
        mockStorage = mock<DeepnoteEnvironmentStorage>();
        mockServerStarter = mock<IDeepnoteServerStarter>();
        mockOutputChannel = mock<IOutputChannel>();

        when(mockContext.globalStorageUri).thenReturn(Uri.file('/global/storage'));
        when(mockStorage.loadEnvironments()).thenResolve([]);

        manager = new DeepnoteEnvironmentManager(
            instance(mockContext),
            instance(mockStorage),
            instance(mockServerStarter),
            instance(mockOutputChannel)
        );
    });

    suite('activate', () => {
        test('should load environments on activation', async () => {
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

            when(mockStorage.loadEnvironments()).thenResolve(existingConfigs);

            manager.activate();
            // Wait for async initialization
            await manager.waitForInitialization();

            const configs = manager.listEnvironments();
            assert.strictEqual(configs.length, 1);
            assert.strictEqual(configs[0].id, 'existing-config');
        });
    });

    suite('createEnvironment', () => {
        test('should create a new kernel environment', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config = await manager.createEnvironment({
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

            verify(mockStorage.saveEnvironments(anything())).once();
        });

        test('should generate unique IDs for each environment', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config1 = await manager.createEnvironment({
                name: 'Config 1',
                pythonInterpreter: testInterpreter
            });

            const config2 = await manager.createEnvironment({
                name: 'Config 2',
                pythonInterpreter: testInterpreter
            });

            assert.notEqual(config1.id, config2.id);
        });

        test('should fire onDidChangeEnvironments event', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            let eventFired = false;
            manager.onDidChangeEnvironments(() => {
                eventFired = true;
            });

            await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            assert.isTrue(eventFired);
        });
    });

    suite('listEnvironments', () => {
        test('should return empty array initially', () => {
            const configs = manager.listEnvironments();
            assert.deepStrictEqual(configs, []);
        });

        test('should return all created environments', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            await manager.createEnvironment({ name: 'Config 1', pythonInterpreter: testInterpreter });
            await manager.createEnvironment({ name: 'Config 2', pythonInterpreter: testInterpreter });

            const configs = manager.listEnvironments();
            assert.strictEqual(configs.length, 2);
        });
    });

    suite('getEnvironment', () => {
        test('should return undefined for non-existent ID', () => {
            const config = manager.getEnvironment('non-existent');
            assert.isUndefined(config);
        });

        test('should return environment by ID', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const created = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            const found = manager.getEnvironment(created.id);
            assert.strictEqual(found?.id, created.id);
            assert.strictEqual(found?.name, 'Test');
        });
    });

    suite('updateEnvironment', () => {
        test('should update environment name', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config = await manager.createEnvironment({
                name: 'Original Name',
                pythonInterpreter: testInterpreter
            });

            await manager.updateEnvironment(config.id, { name: 'Updated Name' });

            const updated = manager.getEnvironment(config.id);
            assert.strictEqual(updated?.name, 'Updated Name');
            verify(mockStorage.saveEnvironments(anything())).atLeast(1);
        });

        test('should update packages', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter,
                packages: ['numpy']
            });

            await manager.updateEnvironment(config.id, { packages: ['numpy', 'pandas'] });

            const updated = manager.getEnvironment(config.id);
            assert.deepStrictEqual(updated?.packages, ['numpy', 'pandas']);
            verify(mockStorage.saveEnvironments(anything())).atLeast(1);
        });

        test('should throw error for non-existent environment', async () => {
            await assert.isRejected(
                manager.updateEnvironment('non-existent', { name: 'Test' }),
                'Environment not found: non-existent'
            );
        });

        test('should fire onDidChangeEnvironments event', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            let eventFired = false;
            manager.onDidChangeEnvironments(() => {
                eventFired = true;
            });

            await manager.updateEnvironment(config.id, { name: 'Updated' });

            assert.isTrue(eventFired);
        });
    });

    suite('deleteEnvironment', () => {
        test('should delete environment', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            await manager.deleteEnvironment(config.id);

            const deleted = manager.getEnvironment(config.id);
            assert.isUndefined(deleted);
            verify(mockStorage.saveEnvironments(anything())).atLeast(1);
        });

        test('should throw error for non-existent environment', async () => {
            await assert.isRejected(manager.deleteEnvironment('non-existent'), 'Environment not found: non-existent');
        });
    });

    suite('updateLastUsed', () => {
        test('should update lastUsedAt timestamp', async () => {
            when(mockStorage.saveEnvironments(anything())).thenResolve();

            const config = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            const originalLastUsed = config.lastUsedAt;
            await new Promise((resolve) => setTimeout(resolve, 10));
            await manager.updateLastUsed(config.id);

            const updated = manager.getEnvironment(config.id);
            assert.isTrue(updated!.lastUsedAt > originalLastUsed);
        });

        test('should do nothing for non-existent environment', async () => {
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
