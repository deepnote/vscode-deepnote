import { assert } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import { Uri, EventEmitter } from 'vscode';
import { DeepnoteConfigurationTreeDataProvider } from './deepnoteConfigurationTreeDataProvider';
import { IDeepnoteConfigurationManager } from '../types';
import {
    DeepnoteKernelConfiguration,
    DeepnoteKernelConfigurationWithStatus,
    KernelConfigurationStatus
} from './deepnoteKernelConfiguration';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { ConfigurationTreeItemType } from './deepnoteConfigurationTreeItem';

suite('DeepnoteConfigurationTreeDataProvider', () => {
    let provider: DeepnoteConfigurationTreeDataProvider;
    let mockConfigManager: IDeepnoteConfigurationManager;
    let configChangeEmitter: EventEmitter<void>;

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3')
    };

    const testConfig1: DeepnoteKernelConfiguration = {
        id: 'config-1',
        name: 'Config 1',
        pythonInterpreter: testInterpreter,
        venvPath: Uri.file('/path/to/venv1'),
        createdAt: new Date(),
        lastUsedAt: new Date()
    };

    const testConfig2: DeepnoteKernelConfiguration = {
        id: 'config-2',
        name: 'Config 2',
        pythonInterpreter: testInterpreter,
        venvPath: Uri.file('/path/to/venv2'),
        createdAt: new Date(),
        lastUsedAt: new Date(),
        packages: ['numpy'],
        serverInfo: {
            url: 'http://localhost:8888',
            port: 8888,
            token: 'test-token'
        }
    };

    setup(() => {
        mockConfigManager = mock<IDeepnoteConfigurationManager>();
        configChangeEmitter = new EventEmitter<void>();

        when(mockConfigManager.onDidChangeConfigurations).thenReturn(configChangeEmitter.event);
        when(mockConfigManager.listConfigurations()).thenReturn([]);

        provider = new DeepnoteConfigurationTreeDataProvider(instance(mockConfigManager));
    });

    suite('getChildren - Root Level', () => {
        test('should return create action when no configurations exist', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([]);

            const children = await provider.getChildren();

            assert.strictEqual(children.length, 1);
            assert.strictEqual(children[0].type, ConfigurationTreeItemType.CreateAction);
        });

        test('should return configurations and create action', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig1, testConfig2]);
            when(mockConfigManager.getConfigurationWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: KernelConfigurationStatus.Stopped
            } as DeepnoteKernelConfigurationWithStatus);
            when(mockConfigManager.getConfigurationWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: KernelConfigurationStatus.Running
            } as DeepnoteKernelConfigurationWithStatus);

            const children = await provider.getChildren();

            assert.strictEqual(children.length, 3); // 2 configs + create action
            assert.strictEqual(children[0].type, ConfigurationTreeItemType.Configuration);
            assert.strictEqual(children[1].type, ConfigurationTreeItemType.Configuration);
            assert.strictEqual(children[2].type, ConfigurationTreeItemType.CreateAction);
        });

        test('should include status for each configuration', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig1, testConfig2]);
            when(mockConfigManager.getConfigurationWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: KernelConfigurationStatus.Stopped
            } as DeepnoteKernelConfigurationWithStatus);
            when(mockConfigManager.getConfigurationWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: KernelConfigurationStatus.Running
            } as DeepnoteKernelConfigurationWithStatus);

            const children = await provider.getChildren();

            assert.strictEqual(children[0].status, KernelConfigurationStatus.Stopped);
            assert.strictEqual(children[1].status, KernelConfigurationStatus.Running);
        });
    });

    suite('getChildren - Configuration Children', () => {
        test('should return info items for stopped configuration', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig1]);
            when(mockConfigManager.getConfigurationWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: KernelConfigurationStatus.Stopped
            } as DeepnoteKernelConfigurationWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);

            assert.isAtLeast(infoItems.length, 3); // At least: Python, Venv, Last used
            assert.isTrue(infoItems.every((item) => item.type === ConfigurationTreeItemType.InfoItem));
        });

        test('should include port and URL for running configuration', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig2]);
            when(mockConfigManager.getConfigurationWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: KernelConfigurationStatus.Running
            } as DeepnoteKernelConfigurationWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);

            const labels = infoItems.map((item) => item.label as string);
            const hasPort = labels.some((label) => label.includes('Port:') && label.includes('8888'));
            const hasUrl = labels.some((label) => label.includes('URL:') && label.includes('http://localhost:8888'));

            assert.isTrue(hasPort, 'Should include port info');
            assert.isTrue(hasUrl, 'Should include URL info');
        });

        test('should include packages when present', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig2]);
            when(mockConfigManager.getConfigurationWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: KernelConfigurationStatus.Running
            } as DeepnoteKernelConfigurationWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);

            const labels = infoItems.map((item) => item.label as string);
            const hasPackages = labels.some((label) => label.includes('Packages:') && label.includes('numpy'));

            assert.isTrue(hasPackages);
        });

        test('should return empty array for non-configuration items', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([]);

            const rootChildren = await provider.getChildren();
            const createAction = rootChildren[0];
            const children = await provider.getChildren(createAction);

            assert.deepStrictEqual(children, []);
        });

        test('should return empty array for info items', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig1]);
            when(mockConfigManager.getConfigurationWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: KernelConfigurationStatus.Stopped
            } as DeepnoteKernelConfigurationWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);
            const children = await provider.getChildren(infoItems[0]);

            assert.deepStrictEqual(children, []);
        });
    });

    suite('getTreeItem', () => {
        test('should return the same tree item', async () => {
            when(mockConfigManager.listConfigurations()).thenReturn([testConfig1]);
            when(mockConfigManager.getConfigurationWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: KernelConfigurationStatus.Stopped
            } as DeepnoteKernelConfigurationWithStatus);

            const children = await provider.getChildren();
            const item = children[0];
            const treeItem = provider.getTreeItem(item);

            assert.strictEqual(treeItem, item);
        });
    });

    suite('refresh', () => {
        test('should fire onDidChangeTreeData event', (done) => {
            provider.onDidChangeTreeData(() => {
                done();
            });

            provider.refresh();
        });
    });

    suite('Auto-refresh on configuration changes', () => {
        test('should refresh when configurations change', (done) => {
            provider.onDidChangeTreeData(() => {
                done();
            });

            // Simulate configuration change
            configChangeEmitter.fire();
        });
    });

    suite('dispose', () => {
        test('should dispose without errors', () => {
            provider.dispose();
            // Should not throw
        });
    });
});
