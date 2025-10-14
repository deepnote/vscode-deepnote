// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import { IDeepnoteConfigurationManager } from '../types';
import { ConfigurationTreeItemType, DeepnoteConfigurationTreeItem } from './deepnoteConfigurationTreeItem';
import { KernelConfigurationStatus } from './deepnoteKernelConfiguration';

/**
 * Tree data provider for the Deepnote kernel configurations view
 */
export class DeepnoteConfigurationTreeDataProvider implements TreeDataProvider<DeepnoteConfigurationTreeItem> {
    private readonly _onDidChangeTreeData = new EventEmitter<DeepnoteConfigurationTreeItem | undefined | void>();
    public readonly onDidChangeTreeData: Event<DeepnoteConfigurationTreeItem | undefined | void> =
        this._onDidChangeTreeData.event;

    constructor(private readonly configurationManager: IDeepnoteConfigurationManager) {
        // Listen to configuration changes and refresh the tree
        this.configurationManager.onDidChangeConfigurations(() => {
            this.refresh();
        });
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: DeepnoteConfigurationTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: DeepnoteConfigurationTreeItem): Promise<DeepnoteConfigurationTreeItem[]> {
        if (!element) {
            // Root level: show all configurations + create action
            return this.getRootItems();
        }

        // Expanded configuration: show info items
        if (element.type === ConfigurationTreeItemType.Configuration && element.configuration) {
            return this.getConfigurationInfoItems(element);
        }

        return [];
    }

    private async getRootItems(): Promise<DeepnoteConfigurationTreeItem[]> {
        const configurations = this.configurationManager.listConfigurations();
        const items: DeepnoteConfigurationTreeItem[] = [];

        // Add configuration items
        for (const config of configurations) {
            const statusInfo = this.configurationManager.getConfigurationWithStatus(config.id);
            const status = statusInfo?.status || KernelConfigurationStatus.Stopped;

            const item = new DeepnoteConfigurationTreeItem(ConfigurationTreeItemType.Configuration, config, status);

            items.push(item);
        }

        // Add create action at the end
        items.push(new DeepnoteConfigurationTreeItem(ConfigurationTreeItemType.CreateAction));

        return items;
    }

    private getConfigurationInfoItems(element: DeepnoteConfigurationTreeItem): DeepnoteConfigurationTreeItem[] {
        const config = element.configuration;
        if (!config) {
            return [];
        }

        const items: DeepnoteConfigurationTreeItem[] = [];
        const statusInfo = this.configurationManager.getConfigurationWithStatus(config.id);

        // Server status and port
        if (statusInfo?.status === KernelConfigurationStatus.Running && config.serverInfo) {
            items.push(DeepnoteConfigurationTreeItem.createInfoItem(`Port: ${config.serverInfo.port}`, 'port'));
            items.push(DeepnoteConfigurationTreeItem.createInfoItem(`URL: ${config.serverInfo.url}`, 'globe'));
        }

        // Python interpreter
        items.push(
            DeepnoteConfigurationTreeItem.createInfoItem(
                `Python: ${this.getShortPath(config.pythonInterpreter.uri.fsPath)}`,
                'symbol-namespace'
            )
        );

        // Venv path
        items.push(
            DeepnoteConfigurationTreeItem.createInfoItem(`Venv: ${this.getShortPath(config.venvPath.fsPath)}`, 'folder')
        );

        // Packages
        if (config.packages && config.packages.length > 0) {
            items.push(
                DeepnoteConfigurationTreeItem.createInfoItem(`Packages: ${config.packages.join(', ')}`, 'package')
            );
        } else {
            items.push(DeepnoteConfigurationTreeItem.createInfoItem('Packages: (none)', 'package'));
        }

        // Toolkit version
        if (config.toolkitVersion) {
            items.push(DeepnoteConfigurationTreeItem.createInfoItem(`Toolkit: ${config.toolkitVersion}`, 'versions'));
        }

        // Timestamps
        items.push(
            DeepnoteConfigurationTreeItem.createInfoItem(`Created: ${config.createdAt.toLocaleString()}`, 'history')
        );

        items.push(
            DeepnoteConfigurationTreeItem.createInfoItem(`Last used: ${config.lastUsedAt.toLocaleString()}`, 'clock')
        );

        return items;
    }

    /**
     * Shorten a file path for display (show last 2-3 segments)
     */
    private getShortPath(fullPath: string): string {
        const parts = fullPath.split(/[/\\]/);
        if (parts.length <= 3) {
            return fullPath;
        }

        // Show last 3 segments with ellipsis
        return `.../${parts.slice(-3).join('/')}`;
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
