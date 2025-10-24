// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Disposable, Event, EventEmitter, TreeDataProvider, TreeItem } from 'vscode';
import { IDeepnoteEnvironmentManager } from '../types';
import { EnvironmentTreeItemType, DeepnoteEnvironmentTreeItem } from './deepnoteEnvironmentTreeItem.node';
import { EnvironmentStatus } from './deepnoteEnvironment';

/**
 * Tree data provider for the Deepnote kernel environments view
 */
export class DeepnoteEnvironmentTreeDataProvider implements TreeDataProvider<DeepnoteEnvironmentTreeItem> {
    private readonly _onDidChangeTreeData = new EventEmitter<DeepnoteEnvironmentTreeItem | undefined | void>();
    private readonly disposables: Disposable[] = [];

    constructor(private readonly environmentManager: IDeepnoteEnvironmentManager) {
        // Listen to environment changes and refresh the tree
        this.disposables.push(
            this.environmentManager.onDidChangeEnvironments(() => {
                this.refresh();
            })
        );
    }

    public get onDidChangeTreeData(): Event<DeepnoteEnvironmentTreeItem | undefined | void> {
        return this._onDidChangeTreeData.event;
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: DeepnoteEnvironmentTreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: DeepnoteEnvironmentTreeItem): Promise<DeepnoteEnvironmentTreeItem[]> {
        if (!element) {
            // Root level: show all environments + create action
            return this.getRootItems();
        }

        // Expanded environment: show info items
        if (element.type === EnvironmentTreeItemType.Environment && element.environment) {
            return this.getEnvironmentInfoItems(element);
        }

        return [];
    }

    private async getRootItems(): Promise<DeepnoteEnvironmentTreeItem[]> {
        const environments = this.environmentManager.listEnvironments();
        const items: DeepnoteEnvironmentTreeItem[] = [];

        // Add environment items
        for (const config of environments) {
            const statusInfo = this.environmentManager.getEnvironmentWithStatus(config.id);
            const status = statusInfo?.status || EnvironmentStatus.Stopped;

            const item = new DeepnoteEnvironmentTreeItem(
                EnvironmentTreeItemType.Environment,
                // deepnoteEnvironmentToView(config),
                config,
                status
            );

            items.push(item);
        }

        // Add create action at the end
        items.push(new DeepnoteEnvironmentTreeItem(EnvironmentTreeItemType.CreateAction));

        return items;
    }

    private getEnvironmentInfoItems(element: DeepnoteEnvironmentTreeItem): DeepnoteEnvironmentTreeItem[] {
        const config = element.environment;
        if (!config) {
            return [];
        }

        const items: DeepnoteEnvironmentTreeItem[] = [];
        const statusInfo = this.environmentManager.getEnvironmentWithStatus(config.id);

        // Server status and ports
        if (statusInfo?.status === EnvironmentStatus.Running && config.serverInfo) {
            items.push(
                DeepnoteEnvironmentTreeItem.createInfoItem(
                    `Ports: jupyter=${config.serverInfo.jupyterPort}, lsp=${config.serverInfo.lspPort}`,
                    'port'
                )
            );
            items.push(DeepnoteEnvironmentTreeItem.createInfoItem(`URL: ${config.serverInfo.url}`, 'globe'));
        }

        // Python interpreter
        items.push(
            DeepnoteEnvironmentTreeItem.createInfoItem(
                `Python: ${this.getShortPath(config.pythonInterpreter.uri.fsPath)}`,
                'symbol-namespace'
            )
        );

        // Venv path
        items.push(
            DeepnoteEnvironmentTreeItem.createInfoItem(`Venv: ${this.getShortPath(config.venvPath.fsPath)}`, 'folder')
        );

        // Packages
        if (config.packages && config.packages.length > 0) {
            items.push(
                DeepnoteEnvironmentTreeItem.createInfoItem(`Packages: ${config.packages.join(', ')}`, 'package')
            );
        } else {
            items.push(DeepnoteEnvironmentTreeItem.createInfoItem('Packages: (none)', 'package'));
        }

        // Toolkit version
        if (config.toolkitVersion) {
            items.push(DeepnoteEnvironmentTreeItem.createInfoItem(`Toolkit: ${config.toolkitVersion}`, 'versions'));
        }

        // Timestamps
        items.push(
            DeepnoteEnvironmentTreeItem.createInfoItem(`Created: ${config.createdAt.toLocaleString()}`, 'history')
        );

        items.push(
            DeepnoteEnvironmentTreeItem.createInfoItem(`Last used: ${config.lastUsedAt.toLocaleString()}`, 'clock')
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
        this.disposables.forEach((d) => d.dispose());
    }
}
