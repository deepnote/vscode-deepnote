import { assert } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import { Uri, EventEmitter } from 'vscode';
import { DeepnoteEnvironmentTreeDataProvider } from './deepnoteEnvironmentTreeDataProvider';
import { IDeepnoteEnvironmentManager } from '../types';
import { DeepnoteEnvironment, DeepnoteEnvironmentWithStatus, EnvironmentStatus } from './deepnoteEnvironment';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';
import { EnvironmentTreeItemType } from './deepnoteEnvironmentTreeItem';

suite('DeepnoteEnvironmentTreeDataProvider', () => {
    let provider: DeepnoteEnvironmentTreeDataProvider;
    let mockConfigManager: IDeepnoteEnvironmentManager;
    let configChangeEmitter: EventEmitter<void>;

    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3')
    };

    const testConfig1: DeepnoteEnvironment = {
        id: 'config-1',
        name: 'Config 1',
        pythonInterpreter: testInterpreter,
        venvPath: Uri.file('/path/to/venv1'),
        createdAt: new Date(),
        lastUsedAt: new Date()
    };

    const testConfig2: DeepnoteEnvironment = {
        id: 'config-2',
        name: 'Config 2',
        pythonInterpreter: testInterpreter,
        venvPath: Uri.file('/path/to/venv2'),
        createdAt: new Date(),
        lastUsedAt: new Date(),
        packages: ['numpy'],
        serverInfo: {
            url: 'http://localhost:8888',
            jupyterPort: 8888,
            lspPort: 8889,
            token: 'test-token'
        }
    };

    setup(() => {
        mockConfigManager = mock<IDeepnoteEnvironmentManager>();
        configChangeEmitter = new EventEmitter<void>();

        when(mockConfigManager.onDidChangeEnvironments).thenReturn(configChangeEmitter.event);
        when(mockConfigManager.listEnvironments()).thenReturn([]);

        provider = new DeepnoteEnvironmentTreeDataProvider(instance(mockConfigManager));
    });

    suite('getChildren - Root Level', () => {
        test('should return create action when no environments exist', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([]);

            const children = await provider.getChildren();

            assert.strictEqual(children.length, 1);
            assert.strictEqual(children[0].type, EnvironmentTreeItemType.CreateAction);
        });

        test('should return environments and create action', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig1, testConfig2]);
            when(mockConfigManager.getEnvironmentWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: EnvironmentStatus.Stopped
            } as DeepnoteEnvironmentWithStatus);
            when(mockConfigManager.getEnvironmentWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: EnvironmentStatus.Running
            } as DeepnoteEnvironmentWithStatus);

            const children = await provider.getChildren();

            assert.strictEqual(children.length, 3); // 2 configs + create action
            assert.strictEqual(children[0].type, EnvironmentTreeItemType.Environment);
            assert.strictEqual(children[1].type, EnvironmentTreeItemType.Environment);
            assert.strictEqual(children[2].type, EnvironmentTreeItemType.CreateAction);
        });

        test('should include status for each environment', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig1, testConfig2]);
            when(mockConfigManager.getEnvironmentWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: EnvironmentStatus.Stopped
            } as DeepnoteEnvironmentWithStatus);
            when(mockConfigManager.getEnvironmentWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: EnvironmentStatus.Running
            } as DeepnoteEnvironmentWithStatus);

            const children = await provider.getChildren();

            assert.strictEqual(children[0].status, EnvironmentStatus.Stopped);
            assert.strictEqual(children[1].status, EnvironmentStatus.Running);
        });
    });

    suite('getChildren - Environment Children', () => {
        test('should return info items for stopped environment', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig1]);
            when(mockConfigManager.getEnvironmentWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: EnvironmentStatus.Stopped
            } as DeepnoteEnvironmentWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);

            assert.isAtLeast(infoItems.length, 3); // At least: Python, Venv, Last used
            assert.isTrue(infoItems.every((item) => item.type === EnvironmentTreeItemType.InfoItem));
        });

        test('should include port and URL for running environment', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig2]);
            when(mockConfigManager.getEnvironmentWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: EnvironmentStatus.Running
            } as DeepnoteEnvironmentWithStatus);

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
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig2]);
            when(mockConfigManager.getEnvironmentWithStatus('config-2')).thenReturn({
                ...testConfig2,
                status: EnvironmentStatus.Running
            } as DeepnoteEnvironmentWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);

            const labels = infoItems.map((item) => item.label as string);
            const hasPackages = labels.some((label) => label.includes('Packages:') && label.includes('numpy'));

            assert.isTrue(hasPackages);
        });

        test('should return empty array for non-environment items', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([]);

            const rootChildren = await provider.getChildren();
            const createAction = rootChildren[0];
            const children = await provider.getChildren(createAction);

            assert.deepStrictEqual(children, []);
        });

        test('should return empty array for info items', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig1]);
            when(mockConfigManager.getEnvironmentWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: EnvironmentStatus.Stopped
            } as DeepnoteEnvironmentWithStatus);

            const rootChildren = await provider.getChildren();
            const configItem = rootChildren[0];
            const infoItems = await provider.getChildren(configItem);
            const children = await provider.getChildren(infoItems[0]);

            assert.deepStrictEqual(children, []);
        });
    });

    suite('getTreeItem', () => {
        test('should return the same tree item', async () => {
            when(mockConfigManager.listEnvironments()).thenReturn([testConfig1]);
            when(mockConfigManager.getEnvironmentWithStatus('config-1')).thenReturn({
                ...testConfig1,
                status: EnvironmentStatus.Stopped
            } as DeepnoteEnvironmentWithStatus);

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

    suite('Auto-refresh on environment changes', () => {
        test('should refresh when environments change', (done) => {
            provider.onDidChangeTreeData(() => {
                done();
            });

            // Simulate environment change
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
