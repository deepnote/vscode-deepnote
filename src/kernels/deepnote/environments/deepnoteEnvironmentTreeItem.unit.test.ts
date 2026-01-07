import { assert } from 'chai';
import { ThemeIcon, TreeItemCollapsibleState, Uri } from 'vscode';

import { DeepnoteEnvironmentTreeItem, EnvironmentTreeItemType } from './deepnoteEnvironmentTreeItem.node';
import { DeepnoteEnvironment } from './deepnoteEnvironment';
import { PythonEnvironment } from '../../../platform/pythonEnvironments/info';

suite('DeepnoteEnvironmentTreeItem', () => {
    const testInterpreter: PythonEnvironment = {
        id: 'test-python-id',
        uri: Uri.file('/usr/bin/python3')
    };

    const testEnvironment: DeepnoteEnvironment = {
        id: 'test-config-id',
        name: 'Test Environment',
        pythonInterpreter: testInterpreter,
        venvPath: Uri.file('/path/to/venv'),
        managedVenv: true,
        createdAt: new Date('2024-01-01T10:00:00Z'),
        lastUsedAt: new Date('2024-01-01T12:00:00Z')
    };

    suite('Environment Item', () => {
        test('should create environment item', () => {
            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, testEnvironment);

            assert.strictEqual(item.type, EnvironmentTreeItemType.Environment);
            assert.strictEqual(item.environment, testEnvironment);
            assert.strictEqual(item.label, 'Test Environment');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.Collapsed);
        });

        test('should include last used time in description', () => {
            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, testEnvironment);

            assert.include(item.description as string, 'Last used:');
        });

        test('should have tooltip with environment details', () => {
            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, testEnvironment);

            const tooltip = `${item.tooltip}`;
            assert.include(tooltip, 'Test Environment');
            assert.include(tooltip, testInterpreter.uri.toString(true));
        });

        test('should include packages in tooltip when present', () => {
            const configWithPackages: DeepnoteEnvironment = {
                ...testEnvironment,
                packages: ['numpy', 'pandas']
            };

            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, configWithPackages);

            const tooltip = item.tooltip as string;
            assert.include(tooltip, 'numpy');
            assert.include(tooltip, 'pandas');
        });
    });

    suite('Info Item', () => {
        test('should create info item', () => {
            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.InfoItem, undefined, 'Info Label');

            assert.strictEqual(item.type, EnvironmentTreeItemType.InfoItem);
            assert.strictEqual(item.label, 'Info Label');
            assert.strictEqual(item.contextValue, 'deepnoteEnvironment.info');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
        });

        test('should create info item with icon', () => {
            const item = DeepnoteEnvironmentTreeItem.createInfoItem(
                'python',
                'test-config-id',
                'Python: /usr/bin/python3',
                'circle-filled'
            );

            assert.strictEqual(item.label, 'Python: /usr/bin/python3');
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'circle-filled');
        });

        test('should create info item without icon', () => {
            const item = DeepnoteEnvironmentTreeItem.createInfoItem('venv', 'test-config-id', 'No icon');

            assert.strictEqual(item.label, 'No icon');
            assert.isUndefined(item.iconPath);
        });
    });

    suite('Create Action Item', () => {
        test('should create action item', () => {
            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.CreateAction);

            assert.strictEqual(item.type, EnvironmentTreeItemType.CreateAction);
            assert.strictEqual(item.label, 'Create New Environment');
            assert.strictEqual(item.contextValue, 'deepnoteEnvironment.create');
            assert.strictEqual(item.collapsibleState, TreeItemCollapsibleState.None);
            assert.instanceOf(item.iconPath, ThemeIcon);
            assert.strictEqual((item.iconPath as ThemeIcon).id, 'add');
        });

        test('should have command', () => {
            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.CreateAction);

            assert.ok(item.command);
            assert.strictEqual(item.command?.command, 'deepnote.environments.create');
            assert.strictEqual(item.command?.title, 'Create Environment');
        });
    });

    suite('Relative Time Formatting', () => {
        test('should show "just now" for recent times', () => {
            const recentConfig: DeepnoteEnvironment = {
                ...testEnvironment,
                lastUsedAt: new Date()
            };

            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, recentConfig);

            assert.include(item.description as string, 'just now');
        });

        test('should handle negative time (few seconds in the past)', () => {
            const fewSecondsAgo = new Date(Date.now() - 5 * 1000);
            const config: DeepnoteEnvironment = {
                ...testEnvironment,
                lastUsedAt: fewSecondsAgo
            };

            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, config);

            assert.include(item.description as string, 'just now');
        });

        test('should show minutes ago', () => {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const config: DeepnoteEnvironment = {
                ...testEnvironment,
                lastUsedAt: fiveMinutesAgo
            };

            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, config);

            assert.include(item.description as string, 'minute');
            assert.include(item.description as string, 'ago');
        });

        test('should show hours ago', () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const config: DeepnoteEnvironment = {
                ...testEnvironment,
                lastUsedAt: twoHoursAgo
            };

            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, config);

            assert.include(item.description as string, 'hour');
            assert.include(item.description as string, 'ago');
        });

        test('should show days ago', () => {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            const config: DeepnoteEnvironment = {
                ...testEnvironment,
                lastUsedAt: threeDaysAgo
            };

            const item = new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.Environment, config);

            assert.include(item.description as string, 'day');
            assert.include(item.description as string, 'ago');
        });
    });
});
