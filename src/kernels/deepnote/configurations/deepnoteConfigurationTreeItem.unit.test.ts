import { assert } from 'chai';
import { ThemeIcon, TreeItemCollapsibleState } from 'vscode';
import { DeepnoteConfigurationTreeItem, ConfigurationTreeItemType } from './deepnoteConfigurationTreeItem';
import { DeepnoteKernelConfiguration, KernelConfigurationStatus } from './deepnoteKernelConfiguration';
import { Uri } from 'vscode';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';

suite('DeepnoteConfigurationTreeItem', () => {
    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3')
    };

    const testConfiguration: DeepnoteKernelConfiguration = {
        id: 'test-config-id',
        name: 'Test Configuration',
        pythonInterpreter: testInterpreter,
        venvPath: Uri.file('/path/to/venv'),
        createdAt: new Date('2024-01-01T10:00:00Z'),
        lastUsedAt: new Date('2024-01-01T12:00:00Z')
    };

    suite('Configuration Item', () => {
        test('should create running configuration item', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Running
            );

            assert.strictEqual(item.type, ConfigurationTreeItemType.Configuration);
            assert.strictEqual(item.configuration, testConfiguration);
            assert.strictEqual(item.status, KernelConfigurationStatus.Running);
            assert.include(item.label as string, 'Test Configuration');
            assert.include(item.label as string, '[Running]');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
            assert.strictEqual(item.contextValue, 'deepnoteConfiguration.running');
        });

        test('should create stopped configuration item', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Stopped
            );

            assert.include(item.label as string, '[Stopped]');
            assert.strictEqual(item.contextValue, 'deepnoteConfiguration.stopped');
        });

        test('should create starting configuration item', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Starting
            );

            assert.include(item.label as string, '[Starting...]');
            assert.strictEqual(item.contextValue, 'deepnoteConfiguration.starting');
        });

        test('should have correct icon for running state', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Running
            );

            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'vm-running');
        });

        test('should have correct icon for stopped state', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Stopped
            );

            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'vm-outline');
        });

        test('should have correct icon for starting state', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Starting
            );

            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'loading~spin');
        });

        test('should include last used time in description', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Stopped
            );

            assert.include(item.description as string, 'Last used:');
        });

        test('should have tooltip with configuration details', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                testConfiguration,
                KernelConfigurationStatus.Running
            );

            const tooltip = item.tooltip as string;
            assert.include(tooltip, 'Test Configuration');
            assert.include(tooltip, 'running'); // Status enum value is lowercase
            assert.include(tooltip, testInterpreter.uri.fsPath);
        });

        test('should include packages in tooltip when present', () => {
            const configWithPackages: DeepnoteKernelConfiguration = {
                ...testConfiguration,
                packages: ['numpy', 'pandas']
            };

            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                configWithPackages,
                KernelConfigurationStatus.Stopped
            );

            const tooltip = item.tooltip as string;
            assert.include(tooltip, 'numpy');
            assert.include(tooltip, 'pandas');
        });
    });

    suite('Info Item', () => {
        test('should create info item', () => {
            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.InfoItem,
                undefined,
                undefined,
                'Info Label'
            );

            assert.strictEqual(item.type, ConfigurationTreeItemType.InfoItem);
            assert.strictEqual(item.label, 'Info Label');
            assert.strictEqual(item.contextValue, 'deepnoteConfiguration.info');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
        });

        test('should create info item with icon', () => {
            const item = DeepnoteConfigurationTreeItem.createInfoItem('Port: 8888', 'circle-filled');

            assert.strictEqual(item.label, 'Port: 8888');
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'circle-filled');
        });

        test('should create info item without icon', () => {
            const item = DeepnoteConfigurationTreeItem.createInfoItem('No icon');

            assert.strictEqual(item.label, 'No icon');
            assert.isUndefined(item.iconPath);
        });
    });

    suite('Create Action Item', () => {
        test('should create action item', () => {
            const item = new DeepnoteConfigurationTreeItem(ConfigurationTreeItemType.CreateAction);

            assert.strictEqual(item.type, ConfigurationTreeItemType.CreateAction);
            assert.strictEqual(item.label, 'Create New Configuration');
            assert.strictEqual(item.contextValue, 'deepnoteConfiguration.create');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'add');
        });

        test('should have command', () => {
            const item = new DeepnoteConfigurationTreeItem(ConfigurationTreeItemType.CreateAction);

            assert.ok(item.command);
            assert.strictEqual(item.command?.command, 'deepnote.configurations.create');
            assert.strictEqual(item.command?.title, 'Create Configuration');
        });
    });

    suite('Relative Time Formatting', () => {
        test('should show "just now" for recent times', () => {
            const recentConfig: DeepnoteKernelConfiguration = {
                ...testConfiguration,
                lastUsedAt: new Date()
            };

            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                recentConfig,
                KernelConfigurationStatus.Stopped
            );

            assert.include(item.description as string, 'just now');
        });

        test('should show minutes ago', () => {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const config: DeepnoteKernelConfiguration = {
                ...testConfiguration,
                lastUsedAt: fiveMinutesAgo
            };

            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                config,
                KernelConfigurationStatus.Stopped
            );

            assert.include(item.description as string, 'minute');
            assert.include(item.description as string, 'ago');
        });

        test('should show hours ago', () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const config: DeepnoteKernelConfiguration = {
                ...testConfiguration,
                lastUsedAt: twoHoursAgo
            };

            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                config,
                KernelConfigurationStatus.Stopped
            );

            assert.include(item.description as string, 'hour');
            assert.include(item.description as string, 'ago');
        });

        test('should show days ago', () => {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            const config: DeepnoteKernelConfiguration = {
                ...testConfiguration,
                lastUsedAt: threeDaysAgo
            };

            const item = new DeepnoteConfigurationTreeItem(
                ConfigurationTreeItemType.Configuration,
                config,
                KernelConfigurationStatus.Stopped
            );

            assert.include(item.description as string, 'day');
            assert.include(item.description as string, 'ago');
        });
    });
});
