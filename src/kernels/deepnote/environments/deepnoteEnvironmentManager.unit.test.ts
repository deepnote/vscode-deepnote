import { assert, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { anything, instance, mock, when, verify } from 'ts-mockito';
import { Uri } from 'vscode';
import * as fs from 'fs';
import * as os from 'os';

import { DeepnoteEnvironmentManager } from './deepnoteEnvironmentManager.node';
import { DeepnoteEnvironmentStorage } from './deepnoteEnvironmentStorage.node';
import { IFileSystem } from '../../../platform/common/platform/types';
import { IProcessService, IProcessServiceFactory } from '../../../platform/common/process/types.node';
import { IExtensionContext, IOutputChannel } from '../../../platform/common/types';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';

use(chaiAsPromised);

suite('DeepnoteEnvironmentManager', () => {
    let manager: DeepnoteEnvironmentManager;
    let mockContext: IExtensionContext;
    let mockStorage: DeepnoteEnvironmentStorage;
    let mockOutputChannel: IOutputChannel;
    let mockFileSystem: IFileSystem;
    let mockProcessServiceFactory: IProcessServiceFactory;
    let mockProcessService: IProcessService;
    let testGlobalStoragePath: string;

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3'),
        version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
    } as PythonEnvironment;

    setup(() => {
        mockContext = mock<IExtensionContext>();
        mockStorage = mock<DeepnoteEnvironmentStorage>();
        mockOutputChannel = mock<IOutputChannel>();
        mockFileSystem = mock<IFileSystem>();
        mockProcessServiceFactory = mock<IProcessServiceFactory>();
        mockProcessService = mock<IProcessService>();

        // Create a temporary directory for test storage
        testGlobalStoragePath = fs.mkdtempSync(`${os.tmpdir()}/deepnote-test-`);

        when(mockContext.globalStorageUri).thenReturn(Uri.file(testGlobalStoragePath));
        when(mockStorage.loadEnvironments()).thenResolve([]);
        when(mockStorage.saveEnvironments(anything())).thenResolve();
        when(mockOutputChannel.appendLine(anything())).thenReturn();

        // Configure mockFileSystem to actually delete directories for testing
        when(mockFileSystem.delete(anything())).thenCall((uri: Uri) => {
            const dirPath = uri.fsPath;
            if (fs.existsSync(dirPath)) {
                fs.rmSync(dirPath, { recursive: true, force: true });
            }
            return Promise.resolve();
        });

        // Configure mock process service to make getVenvPathIfInVenv return undefined
        // (stdout starts with '0' means "not in a virtual environment")
        when(mockProcessServiceFactory.create(anything(), anything())).thenResolve(instance(mockProcessService));
        when(mockProcessService.exec(anything(), anything(), anything())).thenResolve({
            stdout: '0|/usr/lib/python3',
            stderr: ''
        });

        manager = new DeepnoteEnvironmentManager(
            instance(mockContext),
            instance(mockStorage),
            instance(mockOutputChannel),
            instance(mockFileSystem),
            instance(mockProcessServiceFactory)
        );
    });

    teardown(() => {
        // Clean up the temporary directory after each test
        if (testGlobalStoragePath && fs.existsSync(testGlobalStoragePath)) {
            fs.rmSync(testGlobalStoragePath, { recursive: true, force: true });
        }
    });

    suite('activate', () => {
        test('should load environments on activation', async () => {
            const existingConfigs = [
                {
                    id: 'existing-config',
                    name: 'Existing',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/path/to/venv'),
                    managedVenv: true,
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

        test('should delete virtual environment directory from disk', async () => {
            const config = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            // Create the virtual environment directory to simulate it existing
            const venvDirPath = config.venvPath.fsPath;
            fs.mkdirSync(venvDirPath, { recursive: true });

            // Create a dummy file inside to make it a "real" directory
            fs.writeFileSync(`${venvDirPath}/test.txt`, 'test content');

            // Verify directory and file exist before deletion
            assert.isTrue(fs.existsSync(venvDirPath), 'Directory should exist before deletion');
            assert.isTrue(fs.existsSync(`${venvDirPath}/test.txt`), 'File should exist before deletion');

            // Delete the environment
            await manager.deleteEnvironment(config.id);

            // Verify directory no longer exists
            assert.isFalse(fs.existsSync(venvDirPath), 'Directory should not exist after deletion');
        });

        test('deletion does NOT reference a server-stop map — the dead environmentServers map is gone (stopping is the view’s job)', async () => {
            const config = await manager.createEnvironment({
                name: 'Test',
                pythonInterpreter: testInterpreter
            });

            // The manager has no server-starter collaborator and no per-environment server map:
            // deletion is purely "delete the env (and managed venv)". Stopping servers is the
            // view's responsibility (DeepnoteEnvironmentsView.deleteEnvironmentCommand).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.isUndefined((manager as any).environmentServers, 'the dead environmentServers map must not exist');

            // Deletion succeeds with no server-stopping collaborator wired in.
            await manager.deleteEnvironment(config.id);

            assert.isUndefined(manager.getEnvironment(config.id));
        });
    });

    suite('updateLastUsed', () => {
        test('should update lastUsedAt timestamp', async () => {
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

    suite('environment migration', () => {
        test('should migrate hash-based venv paths to UUID-based paths', async () => {
            const oldHashBasedConfig = {
                id: 'abcd1234-5678-90ab-cdef-123456789012',
                name: 'Old Hash Config',
                pythonInterpreter: testInterpreter,
                venvPath: Uri.file('/global/storage/deepnote-venvs/venv_7626587d-1.0.0'),
                managedVenv: true,
                createdAt: new Date(),
                lastUsedAt: new Date()
            };

            when(mockStorage.loadEnvironments()).thenResolve([oldHashBasedConfig]);
            when(mockContext.globalStorageUri).thenReturn(Uri.file('/global/storage'));

            manager.activate();
            await manager.waitForInitialization();

            const configs = manager.listEnvironments();
            assert.strictEqual(configs.length, 1);

            // Should have migrated to UUID-based path
            assert.strictEqual(
                configs[0].venvPath.fsPath,
                '/global/storage/deepnote-venvs/abcd1234-5678-90ab-cdef-123456789012'
            );

            // Should clear toolkit version to force reinstallation
            assert.isUndefined(configs[0].toolkitVersion);

            // Should have saved the migration
            verify(mockStorage.saveEnvironments(anything())).once();
        });

        test('should migrate VS Code storage paths to Cursor storage paths', async () => {
            const vsCodeConfig = {
                id: 'cursor-env-id',
                name: 'VS Code Environment',
                pythonInterpreter: testInterpreter,
                venvPath: Uri.file(
                    '/Library/Application Support/Code/User/globalStorage/deepnote.vscode-deepnote/deepnote-venvs/cursor-env-id'
                ),
                managedVenv: true,
                createdAt: new Date(),
                lastUsedAt: new Date(),
                toolkitVersion: '1.0.0'
            };

            when(mockStorage.loadEnvironments()).thenResolve([vsCodeConfig]);
            when(mockContext.globalStorageUri).thenReturn(
                Uri.file('/Library/Application Support/Cursor/User/globalStorage/deepnote.vscode-deepnote')
            );

            manager.activate();
            await manager.waitForInitialization();

            const configs = manager.listEnvironments();
            assert.strictEqual(configs.length, 1);

            // Should have migrated to Cursor storage
            assert.match(configs[0].venvPath.fsPath, /Cursor.*deepnote-venvs\/cursor-env-id$/);

            // Should clear toolkit version to force reinstallation
            assert.isUndefined(configs[0].toolkitVersion);

            verify(mockStorage.saveEnvironments(anything())).once();
        });

        test('should not migrate environments with correct ID-based paths in correct storage', async () => {
            const testDate = new Date();
            const correctConfig = {
                id: '12345678-1234-1234-1234-123456789abc',
                name: 'Correct Config',
                pythonInterpreter: testInterpreter,
                venvPath: Uri.file('/global/storage/deepnote-venvs/12345678-1234-1234-1234-123456789abc'),
                managedVenv: true,
                createdAt: testDate,
                lastUsedAt: testDate,
                toolkitVersion: '1.0.0',
                packages: []
            };

            when(mockStorage.loadEnvironments()).thenResolve([correctConfig]);
            when(mockContext.globalStorageUri).thenReturn(Uri.file('/global/storage'));

            manager.activate();
            await manager.waitForInitialization();

            const configs = manager.listEnvironments();
            assert.strictEqual(configs.length, 1);

            // Path should remain unchanged
            assert.strictEqual(
                configs[0].venvPath.fsPath,
                '/global/storage/deepnote-venvs/12345678-1234-1234-1234-123456789abc'
            );

            // ID and name should be preserved
            assert.strictEqual(configs[0].id, '12345678-1234-1234-1234-123456789abc');
            assert.strictEqual(configs[0].name, 'Correct Config');

            // Should NOT have saved (no migration needed)
            verify(mockStorage.saveEnvironments(anything())).never();
        });

        test('should not migrate environments with non-UUID IDs when path already matches', async () => {
            const testDate = new Date();
            const customIdConfig = {
                id: 'my-custom-env-id',
                name: 'Custom ID Environment',
                pythonInterpreter: testInterpreter,
                venvPath: Uri.file('/global/storage/deepnote-venvs/my-custom-env-id'),
                managedVenv: true,
                createdAt: testDate,
                lastUsedAt: testDate,
                toolkitVersion: '1.0.0'
            };

            when(mockStorage.loadEnvironments()).thenResolve([customIdConfig]);
            when(mockContext.globalStorageUri).thenReturn(Uri.file('/global/storage'));

            manager.activate();
            await manager.waitForInitialization();

            const configs = manager.listEnvironments();
            assert.strictEqual(configs.length, 1);

            // Path should remain unchanged
            assert.strictEqual(configs[0].venvPath.fsPath, '/global/storage/deepnote-venvs/my-custom-env-id');

            // Toolkit version should NOT be cleared
            assert.strictEqual(configs[0].toolkitVersion, '1.0.0');

            // Should NOT have saved (no migration needed)
            verify(mockStorage.saveEnvironments(anything())).never();
        });

        test('should migrate multiple environments at once', async () => {
            const configs = [
                {
                    id: 'uuid1',
                    name: 'Hash Config',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/global/storage/deepnote-venvs/venv_abc123-1.0.0'),
                    managedVenv: true,
                    createdAt: new Date(),
                    lastUsedAt: new Date()
                },
                {
                    id: 'uuid2',
                    name: 'VS Code Config',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/Code/globalStorage/deepnote-venvs/uuid2'),
                    managedVenv: true,
                    createdAt: new Date(),
                    lastUsedAt: new Date()
                },
                {
                    id: 'uuid3',
                    name: 'Correct Config',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/global/storage/deepnote-venvs/uuid3'),
                    managedVenv: true,
                    createdAt: new Date(),
                    lastUsedAt: new Date()
                }
            ];

            when(mockStorage.loadEnvironments()).thenResolve(configs);
            when(mockContext.globalStorageUri).thenReturn(Uri.file('/global/storage'));

            manager.activate();
            await manager.waitForInitialization();

            const loaded = manager.listEnvironments();
            assert.strictEqual(loaded.length, 3);

            // First two should be migrated
            assert.strictEqual(loaded[0].venvPath.fsPath, '/global/storage/deepnote-venvs/uuid1');
            assert.strictEqual(loaded[1].venvPath.fsPath, '/global/storage/deepnote-venvs/uuid2');
            // Third should remain unchanged
            assert.strictEqual(loaded[2].venvPath.fsPath, '/global/storage/deepnote-venvs/uuid3');

            verify(mockStorage.saveEnvironments(anything())).once();
        });
    });
});
