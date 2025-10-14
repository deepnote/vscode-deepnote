import { assert } from 'chai';
import { anything, instance, mock, when, verify, deepEqual } from 'ts-mockito';
import { Memento, Uri } from 'vscode';
import { DeepnoteConfigurationStorage } from './deepnoteConfigurationStorage';
import { IExtensionContext } from '../../../platform/common/types';
import { IInterpreterService } from '../../../platform/interpreter/contracts';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { DeepnoteKernelConfigurationState } from './deepnoteKernelConfiguration';

suite('DeepnoteConfigurationStorage', () => {
    let storage: DeepnoteConfigurationStorage;
    let mockContext: IExtensionContext;
    let mockInterpreterService: IInterpreterService;
    let mockGlobalState: Memento;

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3'),
        version: { major: 3, minor: 11, patch: 0, raw: '3.11.0' }
    } as PythonEnvironment;

    setup(() => {
        mockContext = mock<IExtensionContext>();
        mockInterpreterService = mock<IInterpreterService>();
        mockGlobalState = mock<Memento>();

        when(mockContext.globalState).thenReturn(instance(mockGlobalState) as any);

        storage = new DeepnoteConfigurationStorage(instance(mockContext), instance(mockInterpreterService));
    });

    suite('loadConfigurations', () => {
        test('should return empty array when no configurations are stored', async () => {
            when(mockGlobalState.get('deepnote.kernelConfigurations', anything())).thenReturn([]);

            const configs = await storage.loadConfigurations();

            assert.deepStrictEqual(configs, []);
        });

        test('should load and deserialize stored configurations', async () => {
            const storedState: DeepnoteKernelConfigurationState = {
                id: 'config-1',
                name: 'Test Config',
                pythonInterpreterPath: '/usr/bin/python3',
                venvPath: '/path/to/venv',
                createdAt: '2025-01-01T00:00:00.000Z',
                lastUsedAt: '2025-01-01T00:00:00.000Z',
                packages: ['numpy', 'pandas'],
                toolkitVersion: '0.2.30',
                description: 'Test configuration'
            };

            when(mockGlobalState.get('deepnote.kernelConfigurations', anything())).thenReturn([storedState]);
            when(mockInterpreterService.getInterpreterDetails(anything())).thenResolve(testInterpreter);

            const configs = await storage.loadConfigurations();

            assert.strictEqual(configs.length, 1);
            assert.strictEqual(configs[0].id, 'config-1');
            assert.strictEqual(configs[0].name, 'Test Config');
            assert.strictEqual(configs[0].pythonInterpreter.uri.fsPath, '/usr/bin/python3');
            assert.strictEqual(configs[0].venvPath.fsPath, '/path/to/venv');
            assert.deepStrictEqual(configs[0].packages, ['numpy', 'pandas']);
            assert.strictEqual(configs[0].toolkitVersion, '0.2.30');
            assert.strictEqual(configs[0].description, 'Test configuration');
        });

        test('should skip configurations with unresolvable interpreters', async () => {
            const storedStates: DeepnoteKernelConfigurationState[] = [
                {
                    id: 'config-1',
                    name: 'Valid Config',
                    pythonInterpreterPath: '/usr/bin/python3',
                    venvPath: '/path/to/venv1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    lastUsedAt: '2025-01-01T00:00:00.000Z'
                },
                {
                    id: 'config-2',
                    name: 'Invalid Config',
                    pythonInterpreterPath: '/invalid/python',
                    venvPath: '/path/to/venv2',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    lastUsedAt: '2025-01-01T00:00:00.000Z'
                }
            ];

            when(mockGlobalState.get('deepnote.kernelConfigurations', anything())).thenReturn(storedStates);
            when(mockInterpreterService.getInterpreterDetails(deepEqual(Uri.file('/usr/bin/python3')))).thenResolve(
                testInterpreter
            );
            when(mockInterpreterService.getInterpreterDetails(deepEqual(Uri.file('/invalid/python')))).thenResolve(
                undefined
            );

            const configs = await storage.loadConfigurations();

            assert.strictEqual(configs.length, 1);
            assert.strictEqual(configs[0].id, 'config-1');
        });

        test('should handle errors gracefully and return empty array', async () => {
            when(mockGlobalState.get('deepnote.kernelConfigurations', anything())).thenThrow(
                new Error('Storage error')
            );

            const configs = await storage.loadConfigurations();

            assert.deepStrictEqual(configs, []);
        });
    });

    suite('saveConfigurations', () => {
        test('should serialize and save configurations', async () => {
            const config = {
                id: 'config-1',
                name: 'Test Config',
                pythonInterpreter: testInterpreter,
                venvPath: Uri.file('/path/to/venv'),
                createdAt: new Date('2025-01-01T00:00:00.000Z'),
                lastUsedAt: new Date('2025-01-01T00:00:00.000Z'),
                packages: ['numpy'],
                toolkitVersion: '0.2.30',
                description: 'Test'
            };

            when(mockGlobalState.update(anything(), anything())).thenResolve();

            await storage.saveConfigurations([config]);

            verify(
                mockGlobalState.update(
                    'deepnote.kernelConfigurations',
                    deepEqual([
                        {
                            id: 'config-1',
                            name: 'Test Config',
                            pythonInterpreterPath: '/usr/bin/python3',
                            venvPath: '/path/to/venv',
                            createdAt: '2025-01-01T00:00:00.000Z',
                            lastUsedAt: '2025-01-01T00:00:00.000Z',
                            packages: ['numpy'],
                            toolkitVersion: '0.2.30',
                            description: 'Test'
                        }
                    ])
                )
            ).once();
        });

        test('should save multiple configurations', async () => {
            const configs = [
                {
                    id: 'config-1',
                    name: 'Config 1',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/path/to/venv1'),
                    createdAt: new Date('2025-01-01T00:00:00.000Z'),
                    lastUsedAt: new Date('2025-01-01T00:00:00.000Z')
                },
                {
                    id: 'config-2',
                    name: 'Config 2',
                    pythonInterpreter: testInterpreter,
                    venvPath: Uri.file('/path/to/venv2'),
                    createdAt: new Date('2025-01-02T00:00:00.000Z'),
                    lastUsedAt: new Date('2025-01-02T00:00:00.000Z')
                }
            ];

            when(mockGlobalState.update(anything(), anything())).thenResolve();

            await storage.saveConfigurations(configs);

            verify(mockGlobalState.update('deepnote.kernelConfigurations', anything())).once();
        });

        test('should throw error if storage update fails', async () => {
            const config = {
                id: 'config-1',
                name: 'Test Config',
                pythonInterpreter: testInterpreter,
                venvPath: Uri.file('/path/to/venv'),
                createdAt: new Date(),
                lastUsedAt: new Date()
            };

            when(mockGlobalState.update(anything(), anything())).thenReject(new Error('Storage error'));

            await assert.isRejected(storage.saveConfigurations([config]), 'Storage error');
        });
    });

    suite('clearConfigurations', () => {
        test('should clear all stored configurations', async () => {
            when(mockGlobalState.update(anything(), anything())).thenResolve();

            await storage.clearConfigurations();

            verify(mockGlobalState.update('deepnote.kernelConfigurations', deepEqual([]))).once();
        });

        test('should throw error if clear fails', async () => {
            when(mockGlobalState.update(anything(), anything())).thenReject(new Error('Storage error'));

            await assert.isRejected(storage.clearConfigurations(), 'Storage error');
        });
    });
});
